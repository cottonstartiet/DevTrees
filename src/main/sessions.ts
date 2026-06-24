import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { BrowserWindow } from 'electron'
import { spawn, type IPty } from 'node-pty'

import type {
  CopilotSession,
  CreateSessionRequest,
  SessionDataEvent,
  SessionExitEvent,
  SessionSnapshot
} from '../shared/sessions'
import { SessionIpcChannels } from '../shared/sessions'

// Per-session rolling output cap. Output beyond this (text bytes) drops the oldest segments so a
// long-running session can't grow memory unbounded; the live terminal keeps its own scrollback.
const MAX_BUFFER_BYTES = 1_500_000
// Coalesce PTY output on a short timer so bursts of tiny chunks become a few IPC messages.
const FLUSH_INTERVAL_MS = 16
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 30
const MAX_DIMENSION = 1000
const MAX_INPUT_BYTES = 100_000
const MAX_PROMPT_BYTES = 200_000

type BufferSegment = { seq: number; data: string }

type SessionEntry = {
  pty: IPty
  meta: CopilotSession
  segments: BufferSegment[]
  bufferBytes: number
  seq: number
  pending: string
  flushTimer: NodeJS.Timeout | null
}

let cachedCliPath: string | null = null

/**
 * Resolve the Copilot CLI executable. The GUI main process may not share the PATH of an
 * interactive shell, so we resolve an absolute path up front and surface an actionable error when
 * it can't be found.
 */
function detectCopilotCli(): string {
  if (cachedCliPath) return cachedCliPath
  try {
    const out = execFileSync('where.exe', ['copilot'], { encoding: 'utf8' })
    const candidates = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (candidates.length === 0) throw new Error('not found')
    // Prefer a real executable over an .exe-less shim when both exist.
    const exe = candidates.find((p) => p.toLowerCase().endsWith('.exe'))
    cachedCliPath = exe ?? candidates[0]
    return cachedCliPath
  } catch {
    throw new Error(
      'Copilot CLI not found. Install it and ensure `copilot` is on your PATH, then try again.'
    )
  }
}

/**
 * Map a resolved CLI path + Copilot args to the actual file/args to spawn. node-pty can launch an
 * .exe directly with an argv array (it handles Windows command-line escaping), but shim scripts
 * (.cmd/.bat/.ps1) must be run through their host interpreter.
 */
function resolveSpawnTarget(cliPath: string, args: string[]): { file: string; args: string[] } {
  const lower = cliPath.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/c', cliPath, ...args] }
  }
  if (lower.endsWith('.ps1')) {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cliPath, ...args]
    }
  }
  return { file: cliPath, args }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

const execFileAsync = promisify(execFile)

/**
 * Forcibly terminate a process and its entire descendant tree on Windows. Copilot spawns child
 * processes (language servers, MCP servers, git, …) that inherit the session's working directory;
 * unless every one of them exits, Windows keeps the worktree folder locked and it can't be deleted.
 * `taskkill /T /F` walks the whole tree rooted at the PTY process so all those handles are released.
 */
async function killProcessTree(pid: number | undefined): Promise<void> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10_000
    })
  } catch (err) {
    // taskkill exits non-zero when the process is already gone ("not found", code 128); that's
    // expected. Anything else (access denied, timeout) means the folder may still be locked.
    const message = err instanceof Error ? err.message : String(err)
    if (!/not found|128/i.test(message)) {
      console.error(`[sessions] taskkill failed for pid ${pid}:`, message)
    }
  }
}

/** Synchronous variant used on app shutdown, where we can't await async work before quitting. */
function killProcessTreeSync(pid: number | undefined): void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000
    })
  } catch {
    /* process (tree) may already be gone, or taskkill timed out on shutdown */
  }
}

class CopilotSessionManager {
  private sessions = new Map<string, SessionEntry>()

  create(req: CreateSessionRequest): CopilotSession {
    const folderPath = typeof req.folderPath === 'string' ? req.folderPath.trim() : ''
    const prompt = typeof req.prompt === 'string' ? req.prompt : ''
    const label = typeof req.label === 'string' && req.label.trim() ? req.label.trim() : 'Copilot'
    if (process.platform !== 'win32') {
      throw new Error('Copilot sessions are currently Windows-only.')
    }
    if (!folderPath) throw new Error('folderPath is required.')
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw new Error('prompt is too large.')
    }

    const cliPath = detectCopilotCli()
    const cols = clampDimension(req.cols, DEFAULT_COLS)
    const rows = clampDimension(req.rows, DEFAULT_ROWS)

    // Pass the prompt as a discrete argv element so node-pty performs the Windows command-line
    // escaping — this sidesteps the manual PowerShell quoting required by the external launcher.
    // With no prompt, omit `-i` to start a plain interactive Copilot session.
    const copilotArgs = prompt.trim()
      ? ['--allow-all-tools', '-i', prompt]
      : ['--allow-all-tools', '--banner']
    const { file, args } = resolveSpawnTarget(cliPath, copilotArgs)

    const pty = spawn(file, args, {
      name: 'xterm-256color',
      cwd: folderPath,
      cols,
      rows,
      env: process.env as { [key: string]: string }
    })

    const id = randomUUID()
    const meta: CopilotSession = {
      id,
      label,
      folderPath,
      status: 'running',
      createdAt: Date.now()
    }
    const entry: SessionEntry = {
      pty,
      meta,
      segments: [],
      bufferBytes: 0,
      seq: 0,
      pending: '',
      flushTimer: null
    }
    this.sessions.set(id, entry)

    pty.onData((data) => {
      entry.pending += data
      if (entry.flushTimer === null) {
        entry.flushTimer = setTimeout(() => this.flush(id), FLUSH_INTERVAL_MS)
      }
    })

    pty.onExit(({ exitCode, signal }) => {
      this.flush(id)
      const current = this.sessions.get(id)
      if (!current) return
      current.meta.status = 'exited'
      current.meta.exitedAt = Date.now()
      current.meta.exitCode = exitCode
      const event: SessionExitEvent = { id, exitCode, signal }
      broadcast(SessionIpcChannels.Exit, event)
    })

    return meta
  }

  private flush(id: string): void {
    const entry = this.sessions.get(id)
    if (!entry) return
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    if (entry.pending.length === 0) return

    const data = entry.pending
    entry.pending = ''
    const seq = ++entry.seq
    entry.segments.push({ seq, data })
    entry.bufferBytes += Buffer.byteLength(data, 'utf8')
    while (entry.bufferBytes > MAX_BUFFER_BYTES && entry.segments.length > 1) {
      const dropped = entry.segments.shift()
      if (dropped) entry.bufferBytes -= Buffer.byteLength(dropped.data, 'utf8')
    }

    const event: SessionDataEvent = { id, seq, data }
    broadcast(SessionIpcChannels.Data, event)
  }

  list(): CopilotSession[] {
    return [...this.sessions.values()].map((e) => ({ ...e.meta }))
  }

  snapshot(id: string): SessionSnapshot | null {
    const entry = this.sessions.get(id)
    if (!entry) return null
    return {
      session: { ...entry.meta },
      buffer: entry.segments.map((s) => s.data).join(''),
      lastSeq: entry.seq
    }
  }

  input(id: string, data: string): void {
    const entry = this.sessions.get(id)
    if (!entry || entry.meta.status !== 'running') return
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) return
    entry.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.sessions.get(id)
    if (!entry || entry.meta.status !== 'running') return
    const c = clampDimension(cols, DEFAULT_COLS)
    const r = clampDimension(rows, DEFAULT_ROWS)
    try {
      entry.pty.resize(c, r)
    } catch {
      /* pty may have exited between the status check and resize */
    }
  }

  async kill(id: string): Promise<void> {
    const entry = this.sessions.get(id)
    if (!entry) return
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    // Drop it from the registry up front so the UI stops tracking it immediately, then tear down
    // the OS process tree so the worktree folder is fully released and can be deleted.
    this.sessions.delete(id)
    const pid = entry.pty.pid
    // Kill the whole tree first, while parent→child links are intact, so taskkill /T can find every
    // descendant; then release node-pty's ConPTY handle.
    await killProcessTree(pid)
    try {
      entry.pty.kill()
    } catch {
      /* already gone */
    }
  }

  killAll(): void {
    for (const entry of this.sessions.values()) {
      const pid = entry.pty.pid
      killProcessTreeSync(pid)
      try {
        entry.pty.kill()
      } catch {
        /* already gone */
      }
    }
    this.sessions.clear()
  }
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(MAX_DIMENSION, Math.max(1, Math.floor(value)))
}

export const copilotSessions = new CopilotSessionManager()
