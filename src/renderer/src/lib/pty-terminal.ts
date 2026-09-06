import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import type {
  TerminalCheckpoint,
  TerminalOutput,
  TerminalSession,
  TerminalTarget
} from '@shared/terminal-session'
import '@xterm/xterm/css/xterm.css'

type TerminalState = { connected: boolean; error: string | null; ended: boolean }

const terminals = new Map<string, PtyTerminal>()
const encoder = new TextEncoder()
let registryOwners = 0
let disposalTimer: ReturnType<typeof setTimeout> | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Lives independently of the selected route; changing views never restarts a CLI. */
export class PtyTerminal {
  readonly terminal: Terminal
  readonly element = document.createElement('div')
  readonly target: TerminalTarget
  private readonly fitAddon = new FitAddon()
  private readonly serializer = new SerializeAddon()
  private state: TerminalState = { connected: false, error: null, ended: false }
  private listeners = new Set<() => void>()
  private attachment = ''
  private seq = -1
  private replaying = false
  private recovering = true
  private applyingSize = false
  private checkpointBytes = 0
  private checkpointAt = 0
  private disposed = false
  private outputQueue = Promise.resolve()
  private inputQueue = Promise.resolve()
  private connectionTimer?: ReturnType<typeof setTimeout>

  constructor(session: TerminalSession, generation: string) {
    this.target = { id: session.id, generation }
    this.element.className = 'h-full min-h-0 w-full'
    this.element.inert = true
    this.terminal = new Terminal({
      rows: 36,
      cols: 110,
      scrollback: 2000,
      fontFamily: "'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: false,
      screenReaderMode: true,
      allowProposedApi: true,
      disableStdin: true,
      // CLI colors and background queries must see the same palette before first mount.
      theme: {
        background: '#000000',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5',
        cursorAccent: '#000000',
        selectionBackground: '#525252'
      }
    })
    this.terminal.loadAddon(this.fitAddon)
    this.terminal.loadAddon(this.serializer)
    // Terminal output must never read or replace the user's system clipboard.
    this.terminal.parser.registerOscHandler(52, () => true)
    this.terminal.onData((data) => {
      if (!this.replaying && !this.disposed) this.write(encoder.encode(data))
    })
    this.terminal.onBinary((data) => {
      if (!this.replaying && !this.disposed) {
        this.write(Uint8Array.from(data, (character) => character.charCodeAt(0)))
      }
    })
    this.terminal.onResize(({ rows, cols }) => {
      if (!this.applyingSize && this.state.connected) {
        void window.api.terminalSessions
          .resize(this.target, rows, cols)
          .catch((error) => this.fail(error))
      }
    })
    void this.connect()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): TerminalState => this.state

  private update(state: Partial<TerminalState>): void {
    this.state = { ...this.state, ...state }
    this.element.inert = !this.state.connected && !this.state.ended
    for (const listener of this.listeners) listener()
  }

  private fail(error: unknown): void {
    if (this.disposed || this.state.ended) return
    this.terminal.options.disableStdin = true
    this.update({ connected: false, error: message(error) })
  }

  private write(data: Uint8Array): void {
    if (this.state.ended || this.disposed) return
    for (let offset = 0; offset < data.length; offset += 16 * 1024) {
      const chunk = Array.from(data.subarray(offset, offset + 16 * 1024))
      this.inputQueue = this.inputQueue
        .then(async () => {
          if (!this.disposed && !this.state.ended && !this.state.error) {
            await window.api.terminalSessions.write(this.target, chunk)
          }
        })
        .catch((error) => this.fail(error))
    }
  }

  private receive = (output: TerminalOutput): void => {
    if (
      this.disposed ||
      output.generation !== this.target.generation ||
      output.attachment !== this.attachment
    )
      return
    this.outputQueue = this.outputQueue
      .then(async () => {
        if (this.disposed || output.attachment !== this.attachment || this.state.error) return
        if (output.seq <= this.seq) return
        if (!output.reset && output.seq !== this.seq + 1) {
          this.fail('Terminal output was interrupted. Reconnect to restore the current screen.')
          return
        }
        this.replaying = output.replay
        // xterm's disableStdin also suppresses device-query replies. Keep the DOM
        // inert during recovery, but allow replies to previously unread output.
        this.terminal.options.disableStdin = output.replay || this.state.ended
        if (output.reset) this.terminal.reset()
        this.applyingSize = true
        this.terminal.resize(output.cols, output.rows)
        this.applyingSize = false
        await new Promise<void>((resolve) =>
          this.terminal.write(Uint8Array.from(output.data), resolve)
        )
        this.replaying = false
        if (this.disposed || output.attachment !== this.attachment || this.state.error) return
        this.seq = output.seq
        const recovered = this.recovering && output.ready
        if (output.ready) {
          this.recovering = false
          clearTimeout(this.connectionTimer)
        }
        const ended = output.ended || this.state.ended
        this.checkpointBytes += output.data.length
        let checkpoint: TerminalCheckpoint | undefined
        if (
          output.checkpointable &&
          !ended &&
          (this.checkpointBytes >= 64 * 1024 || Date.now() - this.checkpointAt >= 250)
        ) {
          checkpoint = {
            data: this.serializer.serialize({ scrollback: 0 }),
            rows: this.terminal.rows,
            cols: this.terminal.cols
          }
          this.checkpointBytes = 0
          this.checkpointAt = Date.now()
        }
        this.terminal.options.disableStdin = ended || this.recovering
        this.update({ connected: !ended && !this.recovering, ended, error: null })
        if (recovered) this.fitVisible()
        if (!ended) {
          // Terminal-generated query responses must be written before acknowledging
          // their output; restoring an acknowledged frame must not send them again.
          await this.inputQueue
          if (this.state.error || output.attachment !== this.attachment) return
          await window.api.terminalSessions.acknowledge(
            this.target,
            output.attachment,
            output.seq,
            checkpoint
          )
        }
      })
      .catch((error) => {
        if (output.attachment !== this.attachment) return
        this.replaying = false
        this.fail(error)
      })
  }

  connect = async (): Promise<void> => {
    if (this.disposed || this.state.ended) return
    this.attachment = crypto.randomUUID()
    const attachment = this.attachment
    this.seq = -1
    this.recovering = true
    this.terminal.options.disableStdin = true
    this.update({ connected: false, error: null })
    clearTimeout(this.connectionTimer)
    this.connectionTimer = setTimeout(() => {
      if (attachment === this.attachment)
        this.fail('Terminal display did not connect. Retry to restore it.')
    }, 10_000)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await window.api.terminalSessions.attach(this.target, attachment, this.receive)
        return
      } catch (error) {
        if (this.disposed || attachment !== this.attachment) return
        if (attempt === 2) {
          clearTimeout(this.connectionTimer)
          this.fail(error)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
  }

  mount(host: HTMLElement): () => void {
    host.appendChild(this.element)
    if (!this.terminal.element) this.terminal.open(this.element)
    const fit = (): void => this.fitVisible()
    const observer = new ResizeObserver(fit)
    observer.observe(host)
    const frame = requestAnimationFrame(() => {
      fit()
      this.terminal.refresh(0, this.terminal.rows - 1)
      this.terminal.focus()
    })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      this.element.remove()
    }
  }

  private fitVisible(): void {
    const host = this.element.parentElement
    if (!host || host.clientWidth <= 30 || host.clientHeight <= 30) return
    const dimensions = this.fitAddon.proposeDimensions()
    if (dimensions) {
      this.terminal.resize(
        Math.max(2, Math.min(400, dimensions.cols)),
        Math.max(2, Math.min(200, dimensions.rows))
      )
    }
  }

  markEnded(): void {
    clearTimeout(this.connectionTimer)
    this.terminal.options.disableStdin = true
    this.update({ ended: true, connected: false })
  }

  async stop(): Promise<void> {
    await window.api.terminalSessions.stop(this.target)
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.connectionTimer)
    this.terminal.dispose()
    this.element.remove()
    this.listeners.clear()
    if (!this.state.ended) {
      void window.api.terminalSessions
        .detach(this.target, this.attachment)
        .catch((error) => console.error('[terminal] detach failed:', error))
    }
  }
}

export function terminalFor(session: TerminalSession): PtyTerminal | undefined {
  if (session.transport !== 'pty' || !session.generation) return undefined
  const existing = terminals.get(session.id)
  if (existing?.target.generation === session.generation) return existing
  if (session.status === 'done' || session.status === 'error') return undefined
  existing?.dispose()
  const terminal = new PtyTerminal(session, session.generation)
  terminals.set(session.id, terminal)
  return terminal
}

export function syncTerminals(sessions: TerminalSession[]): void {
  const ids = new Set(sessions.map((session) => session.id))
  for (const session of sessions) {
    const terminal = terminalFor(session)
    if (session.status === 'done' || session.status === 'error') terminal?.markEnded()
  }
  for (const [id, terminal] of terminals) {
    if (!ids.has(id)) {
      terminal.dispose()
      terminals.delete(id)
    }
  }
}

export function disposeTerminals(): void {
  for (const terminal of terminals.values()) terminal.dispose()
  terminals.clear()
}

export function retainTerminals(): () => void {
  registryOwners++
  clearTimeout(disposalTimer)
  return () => {
    registryOwners--
    // StrictMode replays effects without discarding component state. A same-turn
    // remount must retain the terminal objects those components still reference.
    if (registryOwners === 0) disposalTimer = setTimeout(disposeTerminals, 0)
  }
}
