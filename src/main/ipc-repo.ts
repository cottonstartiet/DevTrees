import { ipcMain } from 'electron'

import type {
  BranchWebUrlRequest,
  BranchWebUrlResult,
  CommitRequest,
  CommitResult,
  CreateBranchRequest,
  CreateBranchResult,
  DetectMergeStateRequest,
  DetectMergeStateResult,
  DiscardAllChangesRequest,
  DiscardAllChangesResult,
  FetchResult,
  FindPullRequestRequest,
  FindPullRequestResult,
  OpenPullRequestRequest,
  OpenPullRequestResult,
  PullResult,
  PushRequest,
  PushResult,
  RebaseOnDefaultRequest,
  RebaseOnDefaultResult,
  RecentCommitsRequest,
  RecentCommitsResult,
  RepoStatus,
  StageFilesRequest,
  StageFilesResult,
  UnpushedCommitsRequest,
  UnpushedCommitsResult,
  UnstageFilesRequest,
  UnstageFilesResult,
  RevertFilesRequest,
  RevertFilesResult,
  WorkingCopyStatusRequest,
  WorkingCopyStatusResult,
  WorktreesOverviewRequest,
  WorktreesOverviewResult
} from '../shared/repo'
import { RepoIpcChannels } from '../shared/repo'
import {
  commitChanges,
  createBranchInFolder,
  detectMergeState,
  discardAllChanges,
  fetchRemote,
  findActivePullRequest,
  getAdoBranchWebUrl,
  getAheadBehind,
  getCurrentBranch,
  getDefaultBranch,
  getRecentCommits,
  getUnpushedCommits,
  getUserAlias,
  getWorkingCopyStatus,
  getWorktreesOverview,
  openPullRequest,
  pullDefaultBranch,
  pushCurrentBranch,
  rebaseOnDefault,
  stageFiles,
  unstageFiles,
  revertFiles
} from './repo-status'

export function registerRepoIpc(): void {
  ipcMain.handle(
    RepoIpcChannels.DefaultBranch,
    async (_event, workspacePath: string): Promise<string | null> => {
      try {
        return await getDefaultBranch(workspacePath)
      } catch (err) {
        console.error('[repo] default-branch failed:', err)
        return null
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.CurrentBranch,
    async (_event, folderPath: string): Promise<string | null> => {
      try {
        return await getCurrentBranch(folderPath)
      } catch (err) {
        console.error('[repo] current-branch failed:', err)
        return null
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.Status,
    async (
      _event,
      workspacePath: string,
      branch: string
    ): Promise<RepoStatus | { error: string }> => {
      try {
        return await getAheadBehind(workspacePath, branch)
      } catch (err) {
        const error = err instanceof Error ? err.message : 'status failed'
        console.error('[repo] status failed:', err)
        return { error }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.Fetch,
    async (_event, workspacePath: string, branch?: string): Promise<FetchResult> => {
      try {
        return await fetchRemote(workspacePath, branch)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.Pull,
    async (_event, workspacePath: string, branch: string): Promise<PullResult> => {
      try {
        return await pullDefaultBranch(workspacePath, branch)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'pull failed' }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.UserAlias,
    async (_event, workspacePath: string): Promise<string> => {
      try {
        return await getUserAlias(workspacePath)
      } catch (err) {
        console.error('[repo] user-alias failed:', err)
        return 'user'
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.CreateBranch,
    async (_event, req: CreateBranchRequest): Promise<CreateBranchResult> => {
      try {
        return await createBranchInFolder(req.folderPath, req.name)
      } catch (err) {
        return {
          ok: false,
          error: 'unknown',
          message: err instanceof Error ? err.message : 'create-branch failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.OpenPullRequest,
    async (_event, req: OpenPullRequestRequest): Promise<OpenPullRequestResult> => {
      try {
        return await openPullRequest(req)
      } catch (err) {
        console.error('[repo] open-pull-request failed:', err)
        return {
          ok: false,
          code: 'git-failed',
          message: err instanceof Error ? err.message : 'open-pull-request failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.FindPullRequest,
    async (_event, req: FindPullRequestRequest): Promise<FindPullRequestResult> => {
      try {
        return await findActivePullRequest(req)
      } catch (err) {
        console.error('[repo] find-pull-request failed:', err)
        return {
          ok: false,
          code: 'git-failed',
          message: err instanceof Error ? err.message : 'find-pull-request failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.WorkingCopyStatus,
    async (_event, req: WorkingCopyStatusRequest): Promise<WorkingCopyStatusResult> => {
      try {
        return await getWorkingCopyStatus(req)
      } catch (err) {
        console.error('[repo] working-copy-status failed:', err)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'working-copy-status failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.RecentCommits,
    async (_event, req: RecentCommitsRequest): Promise<RecentCommitsResult> => {
      try {
        return await getRecentCommits(req)
      } catch (err) {
        console.error('[repo] recent-commits failed:', err)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'recent-commits failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.RebaseOnDefault,
    async (_event, req: RebaseOnDefaultRequest): Promise<RebaseOnDefaultResult> => {
      try {
        return await rebaseOnDefault(req)
      } catch (err) {
        console.error('[repo] rebase-on-default failed:', err)
        return {
          ok: false,
          code: 'git-failed',
          message: err instanceof Error ? err.message : 'rebase failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.DetectMergeState,
    async (_event, req: DetectMergeStateRequest): Promise<DetectMergeStateResult> => {
      try {
        return await detectMergeState(req)
      } catch (err) {
        console.error('[repo] detect-merge-state failed:', err)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'detect-merge-state failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.UnpushedCommits,
    async (_event, req: UnpushedCommitsRequest): Promise<UnpushedCommitsResult> => {
      try {
        return await getUnpushedCommits(req)
      } catch (err) {
        console.error('[repo] unpushed-commits failed:', err)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'unpushed-commits failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.Push,
    async (_event, req: PushRequest): Promise<PushResult> => {
      try {
        return await pushCurrentBranch(req)
      } catch (err) {
        console.error('[repo] push failed:', err)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'push failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.StageFiles,
    async (_event, req: StageFilesRequest): Promise<StageFilesResult> => {
      try {
        return await stageFiles(req)
      } catch (err) {
        console.error('[repo] stage-files failed:', err)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'stage-files failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.UnstageFiles,
    async (_event, req: UnstageFilesRequest): Promise<UnstageFilesResult> => {
      try {
        return await unstageFiles(req)
      } catch (err) {
        console.error('[repo] unstage-files failed:', err)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'unstage-files failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.RevertFiles,
    async (_event, req: RevertFilesRequest): Promise<RevertFilesResult> => {
      try {
        return await revertFiles(req)
      } catch (err) {
        console.error('[repo] revert-files failed:', err)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'revert-files failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.DiscardAllChanges,
    async (_event, req: DiscardAllChangesRequest): Promise<DiscardAllChangesResult> => {
      try {
        return await discardAllChanges(req)
      } catch (err) {
        console.error('[repo] discard-all-changes failed:', err)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'discard-all-changes failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.Commit,
    async (_event, req: CommitRequest): Promise<CommitResult> => {
      try {
        return await commitChanges(req)
      } catch (err) {
        console.error('[repo] commit failed:', err)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'commit failed',
          code: 'git-failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.WorktreesOverview,
    async (_event, req: WorktreesOverviewRequest): Promise<WorktreesOverviewResult> => {
      try {
        return await getWorktreesOverview(req)
      } catch (err) {
        console.error('[repo] worktrees-overview failed:', err)
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'worktrees-overview failed'
        }
      }
    }
  )

  ipcMain.handle(
    RepoIpcChannels.BranchWebUrl,
    async (_event, req: BranchWebUrlRequest): Promise<BranchWebUrlResult> => {
      try {
        return await getAdoBranchWebUrl(req.folderPath, req.branch)
      } catch (err) {
        console.error('[repo] branch-web-url failed:', err)
        return { webUrl: null }
      }
    }
  )
}
