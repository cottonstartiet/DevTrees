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
  RevertFilesRequest,
  RevertFilesResult,
  UnpushedCommitsRequest,
  UnpushedCommitsResult,
  UnstageFilesRequest,
  UnstageFilesResult,
  WorkingCopyStatusRequest,
  WorkingCopyStatusResult,
  WorktreesOverviewRequest,
  WorktreesOverviewResult,
  MyBranchesRequest,
  MyBranchesResult
} from '@shared/repo'

export function getDefaultBranch(workspacePath: string): Promise<string | null> {
  return window.api.repo.defaultBranch(workspacePath)
}

export function getCurrentBranch(folderPath: string): Promise<string | null> {
  return window.api.repo.currentBranch(folderPath)
}

export function getRepoStatus(
  workspacePath: string,
  branch: string
): Promise<RepoStatus | { error: string }> {
  return window.api.repo.status(workspacePath, branch)
}

export function fetchRepo(workspacePath: string, branch?: string): Promise<FetchResult> {
  return window.api.repo.fetch(workspacePath, branch)
}

export function pullRepo(workspacePath: string, branch: string): Promise<PullResult> {
  return window.api.repo.pull(workspacePath, branch)
}

export function pullCurrentBranch(folderPath: string): Promise<PullResult> {
  return window.api.repo.pullCurrentBranch(folderPath)
}

export function getUserAlias(workspacePath: string): Promise<string> {
  return window.api.repo.userAlias(workspacePath)
}

export function createBranch(req: CreateBranchRequest): Promise<CreateBranchResult> {
  return window.api.repo.createBranch(req)
}

export function getWorkingCopyStatus(
  req: WorkingCopyStatusRequest
): Promise<WorkingCopyStatusResult> {
  return window.api.repo.workingCopyStatus(req)
}

export function getRecentCommits(req: RecentCommitsRequest): Promise<RecentCommitsResult> {
  return window.api.repo.recentCommits(req)
}

export function rebaseOnDefault(req: RebaseOnDefaultRequest): Promise<RebaseOnDefaultResult> {
  return window.api.repo.rebaseOnDefault(req)
}

export function getUnpushedCommits(
  req: UnpushedCommitsRequest
): Promise<UnpushedCommitsResult> {
  return window.api.repo.unpushedCommits(req)
}

export function pushBranch(req: PushRequest): Promise<PushResult> {
  return window.api.repo.push(req)
}

export function stageFiles(req: StageFilesRequest): Promise<StageFilesResult> {
  return window.api.repo.stageFiles(req)
}

export function unstageFiles(req: UnstageFilesRequest): Promise<UnstageFilesResult> {
  return window.api.repo.unstageFiles(req)
}

export function revertFiles(req: RevertFilesRequest): Promise<RevertFilesResult> {
  return window.api.repo.revertFiles(req)
}

export function discardAllChanges(req: DiscardAllChangesRequest): Promise<DiscardAllChangesResult> {
  return window.api.repo.discardAllChanges(req)
}

export function commit(req: CommitRequest): Promise<CommitResult> {
  return window.api.repo.commit(req)
}

export function getWorktreesOverview(
  req: WorktreesOverviewRequest
): Promise<WorktreesOverviewResult> {
  return window.api.repo.worktreesOverview(req)
}

export function getMyBranches(req: MyBranchesRequest): Promise<MyBranchesResult> {
  return window.api.repo.listMyBranches(req)
}

export function getBranchWebUrl(req: BranchWebUrlRequest): Promise<BranchWebUrlResult> {
  return window.api.repo.branchWebUrl(req)
}

export function detectMergeState(req: DetectMergeStateRequest): Promise<DetectMergeStateResult> {
  return window.api.repo.detectMergeState(req)
}
