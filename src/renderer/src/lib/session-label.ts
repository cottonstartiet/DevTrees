import type { CopilotSession } from '@shared/sessions'

/** Default branches for which the worktree folder name is a more useful display name. */
const DEFAULT_BRANCHES = new Set(['main', 'master'])

/** Matches the various ways git reports a detached HEAD so we don't show it as a "name". */
const DETACHED_PATTERN = /^detached(@|$)|^\(?HEAD detached|^HEAD$/i

/** Last path/branch segment (the part after the final slash), ignoring trailing slashes. */
function lastSegment(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : value
}

function isDefaultOrDetached(branch: string): boolean {
  return DEFAULT_BRANCHES.has(branch.toLowerCase()) || DETACHED_PATTERN.test(branch)
}

/**
 * Repository/project name for a session, derived from the worktree folder path. Handles the
 * DevTrees worktree convention `<root>\<Repo>.worktrees\<branch>` so a worktree resolves to its
 * repository rather than the branch folder.
 */
function repoNameFromPath(folderPath: string): string {
  const worktreeMatch = folderPath.match(/[\\/]([^\\/]+)\.worktrees[\\/]/i)
  if (worktreeMatch) return worktreeMatch[1]
  return lastSegment(folderPath)
}

/**
 * Primary name shown on a session tab/sidebar row: the branch leaf (part after the final slash).
 * Falls back to the worktree folder name for default/detached branches, and to the session's free
 * label (e.g. "PR #123") when there is no branch at all.
 */
export function sessionPrimaryLabel(session: CopilotSession): string {
  const branch = session.branch?.trim()
  if (!branch) {
    return (
      session.label?.trim() ||
      repoNameFromPath(session.folderPath) ||
      lastSegment(session.folderPath)
    )
  }
  if (isDefaultOrDetached(branch)) {
    return lastSegment(session.folderPath) || session.label?.trim() || branch
  }
  return lastSegment(branch)
}

/**
 * Repository/project name for the sidebar's secondary line. Returns null when it would just
 * duplicate the primary label (compared case-insensitively).
 */
export function sessionRepoLabel(session: CopilotSession): string | null {
  const explicit = session.repository?.trim()
  const repo = lastSegment(explicit || repoNameFromPath(session.folderPath))
  if (!repo) return null
  if (repo.toLowerCase() === sessionPrimaryLabel(session).trim().toLowerCase()) return null
  return repo
}
