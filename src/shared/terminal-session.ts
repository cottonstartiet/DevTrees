/**
 * Copilot CLI sessions that run in an **external terminal**.
 *
 * DevTrees pins the session id when it launches Windows Terminal, then mirrors the
 * session by tailing the CLI's own event log. That gives the Sessions view live status
 * for work happening outside the app, and lets us notify the user when Copilot is
 * blocked on them or has finished a turn.
 */
export type TerminalSessionStatus =
  /** Launched, but the CLI has not written its first event yet. */
  | 'starting'
  /** A model turn or tool call is in flight. */
  | 'working'
  /** Copilot is blocked on the user: a permission prompt or a question. */
  | 'waiting-input'
  /** The turn finished and the CLI is sitting at its prompt. */
  | 'idle'
  /** The terminal process is gone. */
  | 'done'
  /** The session reported a fatal error. */
  | 'error'

export type TerminalSession = {
  /** The Copilot CLI session id, which is also its `session-state` folder name. */
  id: string
  /** Kanban task this session was started for, when it came from the Tasks board. */
  taskId?: string | null
  folderPath: string
  label: string
  repository?: string | null
  branch?: string | null
  status: TerminalSessionStatus
  /** Short human-readable description of what Copilot last did. */
  lastActivity: string
  /** Set while `status` is `waiting-input`: what Copilot is asking for. */
  pendingPrompt?: string | null
  createdAt: number
  updatedAt: number
}

export type WatchTerminalSessionRequest = {
  id: string
  folderPath: string
  label: string
  taskId?: string
  repository?: string
  branch?: string
}

export type TerminalSessionResult =
  | { ok: true; session: TerminalSession }
  | { ok: false; error: string }

/** Statuses where the session is over and no longer polled. */
export const TERMINAL_SESSION_FINAL_STATUSES: readonly TerminalSessionStatus[] = ['done', 'error']

export function isTerminalSessionFinished(status: TerminalSessionStatus): boolean {
  return TERMINAL_SESSION_FINAL_STATUSES.includes(status)
}

/**
 * One row of a session's read-only history, reconstructed from the CLI's event log.
 *
 * `seq` is the source line index. It is stable across both delivery paths — the initial
 * history fetch and live updates — so entries are merged by `seq` rather than appended,
 * which is also how a completed tool call replaces its own in-flight row.
 */
export type TerminalTimelineEntry =
  | { kind: 'userMessage'; seq: number; timestamp?: string | null; text: string }
  | { kind: 'assistantMessage'; seq: number; timestamp?: string | null; text: string }
  | {
      kind: 'toolCall'
      seq: number
      timestamp?: string | null
      toolCallId: string
      name: string
      /** Compact rendering of the tool's arguments. */
      detail: string
      /** `null` while the call is still running. */
      success?: boolean | null
      result?: string | null
    }
  | {
      kind: 'permission'
      seq: number
      timestamp?: string | null
      description: string
      /** `null` while the prompt is still unanswered in the terminal. */
      resolution?: string | null
    }
  | {
      kind: 'notice'
      seq: number
      timestamp?: string | null
      text: string
      level: 'info' | 'error'
    }

/** Backend -> renderer event: a session's new state plus any entries from the same poll. */
export type TerminalSessionUpdate = {
  session: TerminalSession
  entries: TerminalTimelineEntry[]
}

/** Backend -> renderer event carrying a single updated session. */
export const TERMINAL_SESSIONS_UPDATE_EVENT = 'terminal-sessions:update'
