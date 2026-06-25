/**
 * Read-only history of every Copilot CLI session recorded on this machine, sourced from the CLI's
 * own store at `~/.copilot/session-store.db`. These sessions are recorded uniformly regardless of
 * whether they were launched from DevTrees' embedded terminal or from a standalone terminal, so this
 * is the complete cross-source list. DevTrees only reads this store; it never writes to it.
 */
export type CopilotHistorySession = {
  id: string
  /** Working directory the session ran in; also where a resume should be relaunched. */
  cwd: string | null
  repository: string | null
  branch: string | null
  /** Human-readable session title; may be null when the session was never titled. */
  summary: string | null
  /** Repository host the session targeted ("github" | "ado" | null) — not the launch source. */
  hostType: string | null
  /** ISO-8601 timestamps as stored by the CLI (e.g. "2026-06-25T06:50:00.789Z"). */
  createdAt: string | null
  updatedAt: string | null
}

/**
 * Result of listing the history store. Distinguishes an empty-but-healthy store from one that
 * couldn't be read, so the UI can show an actionable error instead of a misleading "no sessions".
 *  - `missing`: the store file does not exist yet (no sessions have ever run).
 *  - `unreadable`: the file exists but could not be opened/queried (locked, corrupt, schema drift).
 */
export type CopilotHistoryListResult =
  | { ok: true; sessions: CopilotHistorySession[] }
  | { ok: false; reason: 'missing' | 'unreadable'; message: string }

export const CopilotHistoryIpcChannels = {
  List: 'copilot-history:list'
} as const

// Copilot session ids are UUID-shaped (hex + hyphens). We validate against this allowlist before
// ever passing an id into a spawned process argv or a shell command, so a malformed/hostile value
// from the store or UI can't smuggle extra arguments or shell metacharacters into a resume launch.
const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/

export function isValidCopilotSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id)
}
