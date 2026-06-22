export type Worktree = {
  path: string
  branch: string | null
  head: string
  isDetached: boolean
  isMain: boolean
  isLocked: boolean
}

export type CreateWorktreeErrorCode = 'invalid-name' | 'already-exists' | 'git-failed' | 'unknown'

export type CreateWorktreeRequest = {
  workspaceId: string
  workspacePath: string
  name: string
}

export type CreateWorktreeResult =
  | { ok: true; worktree: Worktree }
  | { ok: false; error: CreateWorktreeErrorCode; message?: string }

export type DeleteWorktreeErrorCode =
  | 'is-main'
  | 'is-locked'
  | 'not-found'
  | 'has-changes'
  | 'unreachable-commits'
  | 'git-failed'
  | 'unknown'

export type DeleteWorktreeRequest = {
  workspacePath: string
  worktreePath: string
}

export type DeleteWorktreeResult =
  | { ok: true }
  | { ok: false; error: DeleteWorktreeErrorCode; message?: string }

export type WorktreeStatusErrorCode = 'not-found' | 'git-failed' | 'unknown'

export type WorktreeStatusResult =
  | { ok: true; hasChanges: boolean; hasUnreachableCommits: boolean; folderMissing?: boolean }
  | { ok: false; error: WorktreeStatusErrorCode; message?: string }

export const WorktreeIpcChannels = {
  ListForWorkspace: 'worktrees:list-for-workspace',
  Create: 'worktrees:create',
  Delete: 'worktrees:delete',
  Status: 'worktrees:status'
} as const
