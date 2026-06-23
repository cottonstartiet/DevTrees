export type RepoStatus = {
  branch: string
  ahead: number
  behind: number
  hasRemote: boolean
  fetchedAt: number
}

export type RepoStatusResult = { ok: true; status: RepoStatus } | { ok: false; error: string }

export type PullResult =
  | { ok: true; fastForwarded: boolean; alreadyUpToDate: boolean; message?: string }
  | { ok: false; error: string }

export type FetchResult = { ok: true } | { ok: false; error: string }

export type CreateBranchRequest = { folderPath: string; name: string }

export type CreateBranchErrorCode = 'invalid-name' | 'already-exists' | 'git-failed' | 'unknown'

export type CreateBranchResult =
  | { ok: true; branch: string }
  | { ok: false; error: CreateBranchErrorCode; message?: string }

export type OpenPullRequestRequest = { folderPath: string }

export type OpenPullRequestErrorCode =
  | 'detached'
  | 'same-as-default'
  | 'uncommitted'
  | 'unpushed'
  | 'no-remote-branch'
  | 'fetch-failed'
  | 'no-origin'
  | 'unsupported-remote'
  | 'no-default-branch'
  | 'az-not-installed'
  | 'az-not-logged-in'
  | 'az-extension-missing'
  | 'az-pr-exists'
  | 'az-failed'
  | 'git-failed'

export type OpenPullRequestResult =
  | { ok: true; pullRequestId: number; webUrl: string }
  | { ok: false; code: OpenPullRequestErrorCode; message?: string }

export type FindPullRequestRequest = { folderPath: string }

export type FindPullRequestErrorCode =
  | 'detached'
  | 'same-as-default'
  | 'no-default-branch'
  | 'no-origin'
  | 'unsupported-remote'
  | 'az-not-installed'
  | 'az-extension-missing'
  | 'az-not-logged-in'
  | 'az-failed'
  | 'git-failed'

export type ExistingPullRequest = {
  id: number
  title: string
  webUrl: string
  status: string
}

export type FindPullRequestResult =
  | { ok: true; pullRequest: ExistingPullRequest | null }
  | { ok: false; code: FindPullRequestErrorCode; message?: string }

export type WorkingCopyStatusRequest = { folderPath: string }

export type WorkingCopyEntry = {
  /** Current path. For renames, this is the destination. */
  path: string
  /** Original path for rename/copy entries. */
  originalPath?: string
  /** Index status char from porcelain v1 (X). ' ' = no staged change. */
  indexStatus: string
  /** Worktree status char from porcelain v1 (Y). ' ' = no unstaged change. */
  worktreeStatus: string
  /** Entry has a staged change in the index (X !== ' ' && X !== '?'). */
  isStaged: boolean
  /** Entry has an unstaged change in the worktree (Y !== ' ' && Y !== '?'). */
  isUnstaged: boolean
  /** True for `??` porcelain lines. */
  isUntracked: boolean
}

export type WorkingCopyStatusResult =
  | {
      ok: true
      modified: number
      staged: number
      untracked: number
      entries: WorkingCopyEntry[]
    }
  | { ok: false; error: string }

export type StageFilesRequest = { folderPath: string; files: string[] }
export type StageFilesResult = { ok: true } | { ok: false; error: string }

export type UnstageFilesRequest = { folderPath: string; files: string[] }
export type UnstageFilesResult = { ok: true } | { ok: false; error: string }

export type RevertFilesRequest = { folderPath: string; files: string[]; isUntracked: boolean }
export type RevertFilesResult = { ok: true } | { ok: false; error: string }

export type DiscardAllChangesRequest = { folderPath: string }
export type DiscardAllChangesResult = { ok: true } | { ok: false; error: string }

export type CommitErrorCode = 'nothing-to-commit' | 'empty-message' | 'git-failed'
export type CommitRequest = { folderPath: string; message: string; stageAll?: boolean }
export type CommitResult =
  | { ok: true; commitSha: string }
  | { ok: false; error: string; code?: CommitErrorCode }

export type RecentCommit = {
  sha: string
  subject: string
  author: string
  isoTime: string
}

export type RecentCommitsRequest = { folderPath: string; limit?: number }

export type RecentCommitsResult =
  | { ok: true; commits: RecentCommit[]; adoCommitUrlPrefix?: string }
  | { ok: false; error: string }

export type UnpushedCommitsRequest = { folderPath: string; branch: string }

export type UnpushedCommitsResult =
  | { ok: true; commits: RecentCommit[] }
  | { ok: false; error: string }

export type PushRequest = { folderPath: string }

export type PushResult = { ok: true } | { ok: false; error: string }

export type RebaseOnDefaultRequest = {
  folderPath: string
  workspacePath?: string
}

export type RebaseOnDefaultErrorCode =
  | 'dirty'
  | 'conflicts'
  | 'fetch-failed'
  | 'pull-failed'
  | 'rebase-failed'
  | 'no-default-branch'
  | 'git-failed'

export type RebaseOnDefaultResult =
  | { ok: true }
  | { ok: false; code: RebaseOnDefaultErrorCode; message?: string }

export type DetectMergeStateRequest = { folderPath: string }

export type MergeOperation = 'rebase' | 'merge' | 'none'

export type DetectMergeStateResult =
  | {
      ok: true
      state: MergeOperation
      rebaseHeadName?: string
      rebaseOnto?: string
      mergeHeads?: string[]
    }
  | { ok: false; error: string }

export type WorktreeOverviewRow = {
  path: string
  branch: string | null
  isDetached: boolean
  isMain: boolean
  isLocked: boolean
  isDirty: boolean
  ahead: number
  behind: number
  hasRemote: boolean
  lastCommitIso: string | null
  lastCommitSubject: string | null
}

export type WorktreesOverviewRequest = { workspacePath: string }

export type WorktreesOverviewResult =
  | { ok: true; rows: WorktreeOverviewRow[] }
  | { ok: false; error: string }

export type BranchWebUrlRequest = { folderPath: string; branch: string }
export type BranchWebUrlResult = { webUrl: string | null }

export const RepoIpcChannels = {
  DefaultBranch: 'repo:default-branch',
  CurrentBranch: 'repo:current-branch',
  Status: 'repo:status',
  Fetch: 'repo:fetch',
  Pull: 'repo:pull',
  PullCurrentBranch: 'repo:pull-current-branch',
  UserAlias: 'repo:user-alias',
  CreateBranch: 'repo:create-branch',
  OpenPullRequest: 'repo:open-pull-request',
  FindPullRequest: 'repo:find-pull-request',
  WorkingCopyStatus: 'repo:working-copy-status',
  RecentCommits: 'repo:recent-commits',
  StageFiles: 'repo:stage-files',
  UnstageFiles: 'repo:unstage-files',
  RevertFiles: 'repo:revert-files',
  DiscardAllChanges: 'repo:discard-all-changes',
  Commit: 'repo:commit',
  UnpushedCommits: 'repo:unpushed-commits',
  Push: 'repo:push',
  RebaseOnDefault: 'repo:rebase-on-default',
  WorktreesOverview: 'repo:list-worktrees-overview',
  BranchWebUrl: 'repo:branch-web-url',
  DetectMergeState: 'repo:detect-merge-state'
} as const
