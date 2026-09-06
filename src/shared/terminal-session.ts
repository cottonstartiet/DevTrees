/**
 * Copilot CLI sessions shown in DevTrees.
 *
 * Managed sessions use ACP for bidirectional prompts, approvals, elicitation, and live
 * timeline updates. Legacy external-terminal sessions remain readable through the CLI's
 * event log.
 */
export type TerminalSessionStatus =
  /** Launched, but the CLI has not written its first event yet. */
  | 'starting'
  /** A model turn or tool call is in flight. */
  | 'working'
  /** Copilot is blocked on permission, elicitation, or another user decision. */
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

export type StartTerminalSessionRequest = Omit<WatchTerminalSessionRequest, 'id'> & {
  prompt?: string
  resumeSessionId?: string
}

export type TerminalSessionPermissionOption = {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
}

export type TerminalSessionInteraction =
  | {
      kind: 'permission'
      requestId: number
      message: string
      options: TerminalSessionPermissionOption[]
    }
  | {
      kind: 'elicitation'
      requestId: number
      mode: 'form' | 'url'
      message: string
      requestedSchema?: Record<string, unknown> | null
      url?: string | null
    }

export type TerminalSessionInteractionUpdate = {
  sessionId: string
  interaction: TerminalSessionInteraction | null
}

export type RespondTerminalSessionRequest =
  | {
      id: string
      requestId: number
      kind: 'permission'
      optionId: string
    }
  | {
      id: string
      requestId: number
      kind: 'elicitation'
      action: 'accept' | 'decline' | 'cancel'
      content?: Record<string, unknown>
    }

/** Statuses where the session is over and no longer polled. */
export const TERMINAL_SESSION_FINAL_STATUSES: readonly TerminalSessionStatus[] = ['done', 'error']

export function isTerminalSessionFinished(status: TerminalSessionStatus): boolean {
  return TERMINAL_SESSION_FINAL_STATUSES.includes(status)
}

/**
 * One row of a session history, streamed over ACP or reconstructed from a legacy event log.
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
export const TERMINAL_SESSIONS_INTERACTION_EVENT = 'terminal-sessions:interaction'
