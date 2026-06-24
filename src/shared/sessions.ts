export type SessionStatus = 'running' | 'exited'

/**
 * Serializable metadata describing a single embedded Copilot session. The live PTY itself lives in
 * the main process; this is the shape shared with the renderer.
 */
export type CopilotSession = {
  id: string
  label: string
  folderPath: string
  status: SessionStatus
  createdAt: number
  exitedAt?: number
  exitCode?: number
}

export type CreateSessionRequest = {
  folderPath: string
  /**
   * Optional initial prompt. When provided, the session starts with `-i <prompt>` and Copilot
   * executes it immediately. When omitted/empty, a plain interactive Copilot session is started.
   */
  prompt?: string
  label: string
  cols?: number
  rows?: number
}

export type CreateSessionResult =
  | { ok: true; session: CopilotSession }
  | { ok: false; error: string }

/**
 * Full state needed for a renderer terminal to (re)attach to a session: the metadata, the buffered
 * output so far, and the sequence number of the last buffered chunk. Live `Data` events carrying a
 * `seq <= lastSeq` have already been replayed and must be ignored.
 */
export type SessionSnapshot = {
  session: CopilotSession
  buffer: string
  lastSeq: number
}

export type SessionDataEvent = { id: string; seq: number; data: string }

export type SessionExitEvent = { id: string; exitCode: number; signal?: number }

export type SessionInputMessage = { id: string; data: string }

export type SessionResizeMessage = { id: string; cols: number; rows: number }

export const SessionIpcChannels = {
  // invoke/handle (request → result)
  Create: 'sessions:create',
  List: 'sessions:list',
  Snapshot: 'sessions:snapshot',
  Kill: 'sessions:kill',
  // send/on (fire-and-forget, high frequency)
  Input: 'sessions:input',
  Resize: 'sessions:resize',
  // main → renderer events
  Data: 'sessions:data',
  Exit: 'sessions:exit'
} as const
