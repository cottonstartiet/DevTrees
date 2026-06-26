export type SessionStatus = 'running' | 'exited'

/**
 * Serializable metadata describing a single embedded Copilot session. The live PTY itself lives in
 * the Rust backend; this is the shape shared with the renderer.
 */
export type CopilotSession = {
  id: string
  label: string
  folderPath: string
  /** Git branch checked out in the session's worktree, when known. */
  branch?: string
  /** Repository / project name the session belongs to, when known. */
  repository?: string
  status: SessionStatus
  createdAt: number
  exitedAt?: number
  exitCode?: number
}

export type CreateSessionRequest = {
  folderPath: string
  /**
   * Optional initial prompt. When provided the session starts with `-i <prompt>` and Copilot
   * executes it immediately. Mutually exclusive with `resumeSessionId`.
   */
  prompt?: string
  /** Optional Copilot session id to resume (`copilot --resume=<id>`). */
  resumeSessionId?: string
  label: string
  /** Git branch checked out in the session's worktree, when known. */
  branch?: string
  /** Repository / project name the session belongs to, when known. */
  repository?: string
  cols?: number
  rows?: number
}

export type CreateSessionResult =
  | { ok: true; session: CopilotSession }
  | { ok: false; error: string }

/**
 * Full state needed for a renderer terminal to (re)attach to a session: the metadata, the buffered
 * output so far (base64 of raw bytes), and the sequence number of the last buffered chunk. Live
 * `Data` events carrying a `seq <= lastSeq` have already been replayed and must be ignored.
 */
export type SessionSnapshot = {
  session: CopilotSession
  bufferB64: string
  lastSeq: number
}

export type SessionDataEvent = { id: string; seq: number; dataB64: string }

export type SessionExitEvent = { id: string; exitCode: number }

/** Tauri event names emitted by the Rust session manager. */
export const SessionEvents = {
  Data: 'sessions:data',
  Exit: 'sessions:exit'
} as const
