import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import type { AddWorkspaceResult, Workspace } from '../shared/workspace'
import { WorkspaceIpcChannels } from '../shared/workspace'
import type {
  CreateWorktreeRequest,
  CreateWorktreeResult,
  DeleteWorktreeRequest,
  DeleteWorktreeResult,
  Worktree,
  WorktreeStatusResult
} from '../shared/worktree'
import { WorktreeIpcChannels } from '../shared/worktree'
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
import type {
  AdoMyOpenPrsRequest,
  AdoMyOpenPrsResult,
  AdoPrDetailsRequest,
  AdoPrDetailsResult,
  AdoPrThreadsRequest,
  AdoPrThreadsResult
} from '../shared/ado'
import { AdoIpcChannels } from '../shared/ado'
import type { AppInfo, LaunchCopilotCliRequest, LaunchResult } from '../shared/system'
import { SystemIpcChannels } from '../shared/system'
import type {
  CopilotSession,
  CreateSessionRequest,
  CreateSessionResult,
  SessionDataEvent,
  SessionExitEvent,
  SessionSnapshot
} from '../shared/sessions'
import { SessionIpcChannels } from '../shared/sessions'

const api = {
  workspaces: {
    pickAndAdd: (): Promise<AddWorkspaceResult> =>
      ipcRenderer.invoke(WorkspaceIpcChannels.PickAndAdd),
    list: (): Promise<Workspace[]> => ipcRenderer.invoke(WorkspaceIpcChannels.List),
    remove: (id: string): Promise<Workspace[]> =>
      ipcRenderer.invoke(WorkspaceIpcChannels.Remove, id)
  },
  worktrees: {
    listForWorkspace: (workspacePath: string): Promise<Worktree[]> =>
      ipcRenderer.invoke(WorktreeIpcChannels.ListForWorkspace, workspacePath),
    create: (req: CreateWorktreeRequest): Promise<CreateWorktreeResult> =>
      ipcRenderer.invoke(WorktreeIpcChannels.Create, req),
    delete: (req: DeleteWorktreeRequest): Promise<DeleteWorktreeResult> =>
      ipcRenderer.invoke(WorktreeIpcChannels.Delete, req),
    status: (worktreePath: string): Promise<WorktreeStatusResult> =>
      ipcRenderer.invoke(WorktreeIpcChannels.Status, worktreePath)
  },
  repo: {
    defaultBranch: (workspacePath: string): Promise<string | null> =>
      ipcRenderer.invoke(RepoIpcChannels.DefaultBranch, workspacePath),
    currentBranch: (folderPath: string): Promise<string | null> =>
      ipcRenderer.invoke(RepoIpcChannels.CurrentBranch, folderPath),
    status: (workspacePath: string, branch: string): Promise<RepoStatus | { error: string }> =>
      ipcRenderer.invoke(RepoIpcChannels.Status, workspacePath, branch),
    fetch: (workspacePath: string, branch?: string): Promise<FetchResult> =>
      ipcRenderer.invoke(RepoIpcChannels.Fetch, workspacePath, branch),
    pull: (workspacePath: string, branch: string): Promise<PullResult> =>
      ipcRenderer.invoke(RepoIpcChannels.Pull, workspacePath, branch),
    pullCurrentBranch: (folderPath: string): Promise<PullResult> =>
      ipcRenderer.invoke(RepoIpcChannels.PullCurrentBranch, folderPath),
    userAlias: (workspacePath: string): Promise<string> =>
      ipcRenderer.invoke(RepoIpcChannels.UserAlias, workspacePath),
    createBranch: (req: CreateBranchRequest): Promise<CreateBranchResult> =>
      ipcRenderer.invoke(RepoIpcChannels.CreateBranch, req),
    openPullRequest: (req: OpenPullRequestRequest): Promise<OpenPullRequestResult> =>
      ipcRenderer.invoke(RepoIpcChannels.OpenPullRequest, req),
    findActivePullRequest: (req: FindPullRequestRequest): Promise<FindPullRequestResult> =>
      ipcRenderer.invoke(RepoIpcChannels.FindPullRequest, req),
    workingCopyStatus: (req: WorkingCopyStatusRequest): Promise<WorkingCopyStatusResult> =>
      ipcRenderer.invoke(RepoIpcChannels.WorkingCopyStatus, req),
    recentCommits: (req: RecentCommitsRequest): Promise<RecentCommitsResult> =>
      ipcRenderer.invoke(RepoIpcChannels.RecentCommits, req),
    rebaseOnDefault: (req: RebaseOnDefaultRequest): Promise<RebaseOnDefaultResult> =>
      ipcRenderer.invoke(RepoIpcChannels.RebaseOnDefault, req),
    unpushedCommits: (req: UnpushedCommitsRequest): Promise<UnpushedCommitsResult> =>
      ipcRenderer.invoke(RepoIpcChannels.UnpushedCommits, req),
    push: (req: PushRequest): Promise<PushResult> => ipcRenderer.invoke(RepoIpcChannels.Push, req),
    stageFiles: (req: StageFilesRequest): Promise<StageFilesResult> =>
      ipcRenderer.invoke(RepoIpcChannels.StageFiles, req),
    unstageFiles: (req: UnstageFilesRequest): Promise<UnstageFilesResult> =>
      ipcRenderer.invoke(RepoIpcChannels.UnstageFiles, req),
    revertFiles: (req: RevertFilesRequest): Promise<RevertFilesResult> =>
      ipcRenderer.invoke(RepoIpcChannels.RevertFiles, req),
    discardAllChanges: (req: DiscardAllChangesRequest): Promise<DiscardAllChangesResult> =>
      ipcRenderer.invoke(RepoIpcChannels.DiscardAllChanges, req),
    commit: (req: CommitRequest): Promise<CommitResult> =>
      ipcRenderer.invoke(RepoIpcChannels.Commit, req),
    worktreesOverview: (req: WorktreesOverviewRequest): Promise<WorktreesOverviewResult> =>
      ipcRenderer.invoke(RepoIpcChannels.WorktreesOverview, req),
    branchWebUrl: (req: BranchWebUrlRequest): Promise<BranchWebUrlResult> =>
      ipcRenderer.invoke(RepoIpcChannels.BranchWebUrl, req),
    detectMergeState: (req: DetectMergeStateRequest): Promise<DetectMergeStateResult> =>
      ipcRenderer.invoke(RepoIpcChannels.DetectMergeState, req)
  },
  ado: {
    prDetails: (req: AdoPrDetailsRequest): Promise<AdoPrDetailsResult> =>
      ipcRenderer.invoke(AdoIpcChannels.PrDetails, req),
    prThreads: (req: AdoPrThreadsRequest): Promise<AdoPrThreadsResult> =>
      ipcRenderer.invoke(AdoIpcChannels.PrThreads, req),
    myOpenPrs: (req: AdoMyOpenPrsRequest): Promise<AdoMyOpenPrsResult> =>
      ipcRenderer.invoke(AdoIpcChannels.MyOpenPrs, req)
  },
  system: {
    openInVSCode: (folderPath: string): Promise<LaunchResult> =>
      ipcRenderer.invoke(SystemIpcChannels.OpenInVSCode, folderPath),
    openInVSCodeScm: (folderPath: string): Promise<LaunchResult> =>
      ipcRenderer.invoke(SystemIpcChannels.OpenInVSCodeScm, folderPath),
    openInWindowsTerminal: (folderPath: string): Promise<LaunchResult> =>
      ipcRenderer.invoke(SystemIpcChannels.OpenInWindowsTerminal, folderPath),
    openExternal: (url: string): Promise<LaunchResult> =>
      ipcRenderer.invoke(SystemIpcChannels.OpenExternal, url),
    openPath: (folderPath: string): Promise<LaunchResult> =>
      ipcRenderer.invoke(SystemIpcChannels.OpenPath, folderPath),
    launchCopilotCli: (req: LaunchCopilotCliRequest): Promise<LaunchResult> =>
      ipcRenderer.invoke(SystemIpcChannels.LaunchCopilotCli, req),
    getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(SystemIpcChannels.GetAppInfo)
  },
  sessions: {
    create: (req: CreateSessionRequest): Promise<CreateSessionResult> =>
      ipcRenderer.invoke(SessionIpcChannels.Create, req),
    list: (): Promise<CopilotSession[]> => ipcRenderer.invoke(SessionIpcChannels.List),
    snapshot: (id: string): Promise<SessionSnapshot | null> =>
      ipcRenderer.invoke(SessionIpcChannels.Snapshot, id),
    kill: (id: string): Promise<void> => ipcRenderer.invoke(SessionIpcChannels.Kill, id),
    sendInput: (id: string, data: string): void => {
      ipcRenderer.send(SessionIpcChannels.Input, { id, data })
    },
    resize: (id: string, cols: number, rows: number): void => {
      ipcRenderer.send(SessionIpcChannels.Resize, { id, cols, rows })
    },
    onData: (cb: (event: SessionDataEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: SessionDataEvent): void => cb(payload)
      ipcRenderer.on(SessionIpcChannels.Data, listener)
      return () => ipcRenderer.removeListener(SessionIpcChannels.Data, listener)
    },
    onExit: (cb: (event: SessionExitEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: SessionExitEvent): void => cb(payload)
      ipcRenderer.on(SessionIpcChannels.Exit, listener)
      return () => ipcRenderer.removeListener(SessionIpcChannels.Exit, listener)
    }
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
