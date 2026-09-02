/**
 * Tauri backend bridge. Reconstructs the `window.api` surface the renderer historically got from the
 * Electron preload, but backed by Tauri commands via `invoke`. Keeping the same `window.api.<domain>`
 * shape means every existing call site keeps working unchanged after the Electron → Tauri migration.
 *
 * Two Tauri specifics are handled here:
 *  - Command arguments are passed as an object keyed by the Rust parameter name. Tauri converts the
 *    camelCase keys used here to the snake_case Rust params automatically.
 *  - `invoke` REJECTS when a Rust command returns `Err`. The commands model expected failures as
 *    resolved `{ ok: false, ... }` values, but unexpected errors (DB/lock/serialization) still reject.
 *    `result()` converts any such rejection into the discriminated-union failure the UI already
 *    handles, so a backend hiccup surfaces as an in-app error instead of an unhandled rejection.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import type { AddRepositoryResult, Repository } from '@shared/repository'
import type {
  CreateWorktreeRequest,
  CreateWorktreeResult,
  DeleteWorktreeRequest,
  DeleteWorktreeResult,
  Worktree,
  WorktreeStatusResult
} from '@shared/worktree'
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
  MyBranchesRequest,
  MyBranchesResult,
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
  RepoStatusResult,
  RevertFilesRequest,
  RevertFilesResult,
  StageFilesRequest,
  StageFilesResult,
  UnpushedCommitsRequest,
  UnpushedCommitsResult,
  UnstageFilesRequest,
  UnstageFilesResult,
  WorkingCopyStatusRequest,
  WorkingCopyStatusResult,
  WorktreesOverviewRequest,
  WorktreesOverviewResult
} from '@shared/repo'
import type {
  PrChangedFilesRequest,
  PrChangedFilesResult,
  PrCreateThreadRequest,
  PrFileContentRequest,
  PrFileContentResult,
  PrFileDiffRequest,
  PrFileDiffResult,
  PrMutationResult,
  PrReplyRequest,
  PrReviewDetailRequest,
  PrReviewDetailResult,
  PrSetThreadStatusRequest,
  PrSetVoteRequest
} from '@shared/pr-review'
import type {
  RepoOpenPrsRequest,
  RepoOpenPrsResult,
  RepoPrThreadsRequest,
  RepoPrThreadsResult
} from '@shared/reviews'
import type {
  AppInfo,
  LaunchCopilotCliRequest,
  LaunchCopilotResumeRequest,
  LaunchResult
} from '@shared/system'
import type { CopilotHistoryListResult } from '@shared/copilot-history'
import type {
  CopilotSession,
  CreateSessionRequest,
  CreateSessionResult,
  SessionDataEvent,
  SessionExitEvent,
  SessionSnapshot
} from '@shared/sessions'
import { SessionEvents } from '@shared/sessions'
import type {
  ChatCompleteEvent,
  ChatContext,
  ChatConversation,
  ChatDeltaEvent,
  ChatErrorEvent,
  ChatMessage
} from '@shared/chat'
import { ChatEvents } from '@shared/chat'

type Args = Record<string, unknown>

/** A live output chunk for a session, with the raw bytes already decoded from base64. */
export type SessionData = { id: string; seq: number; data: Uint8Array }

/** A session snapshot with its rolling buffer decoded from base64. */
export type DecodedSessionSnapshot = {
  session: CopilotSession
  buffer: Uint8Array
  lastSeq: number
}

function decodeB64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return 'Unexpected backend error.'
}

/**
 * Invoke a command whose result is a discriminated union, converting an unexpected Rust `Err`
 * (rejected promise) into the union's failure variant via `onError` so callers never see a rejection.
 */
async function result<T>(
  command: string,
  args: Args | undefined,
  onError: (message: string) => T
): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (err) {
    return onError(messageOf(err))
  }
}

/** Failure variants for the PR-review commands, whose results share one shape per provider. */
const adoFail = (message: string): { ok: false; code: 'az-failed'; message: string } => ({
  ok: false,
  code: 'az-failed',
  message
})
const ghFail = (message: string): { ok: false; code: 'gh-failed'; message: string } => ({
  ok: false,
  code: 'gh-failed',
  message
})

const api = {
  repositories: {
    pickAndAdd: (): Promise<AddRepositoryResult> =>
      result('repositories_pick_and_add', undefined, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    list: (): Promise<Repository[]> => invoke('repositories_list'),
    remove: (id: string): Promise<Repository[]> => invoke('repositories_remove', { id }),
    reorder: (orderedIds: string[]): Promise<Repository[]> =>
      invoke('repositories_reorder', { orderedIds })
  },
  worktrees: {
    listForRepository: (repositoryPath: string): Promise<Worktree[]> =>
      invoke('worktrees_list_for_repository', { repositoryPath }),
    create: (req: CreateWorktreeRequest): Promise<CreateWorktreeResult> =>
      result('worktrees_create', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    delete: (req: DeleteWorktreeRequest): Promise<DeleteWorktreeResult> =>
      result('worktrees_delete', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    status: (worktreePath: string): Promise<WorktreeStatusResult> =>
      result('worktrees_status', { worktreePath }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      }))
  },
  repo: {
    defaultBranch: (repositoryPath: string): Promise<string | null> =>
      invoke('repo_default_branch', { repositoryPath }),
    currentBranch: (folderPath: string): Promise<string | null> =>
      invoke('repo_current_branch', { folderPath }),
    status: async (
      repositoryPath: string,
      branch: string
    ): Promise<RepoStatus | { error: string }> => {
      const res = await result<RepoStatusResult>(
        'repo_status',
        { repositoryPath, branch },
        (message) => ({ ok: false, error: message })
      )
      return res.ok ? res.status : { error: res.error }
    },
    fetch: (repositoryPath: string, branch?: string): Promise<FetchResult> =>
      result('repo_fetch', { repositoryPath, branch }, (error) => ({ ok: false, error })),
    pull: (repositoryPath: string, branch: string): Promise<PullResult> =>
      result('repo_pull', { repositoryPath, branch }, (error) => ({ ok: false, error })),
    pullCurrentBranch: (folderPath: string): Promise<PullResult> =>
      result('repo_pull_current_branch', { folderPath }, (error) => ({ ok: false, error })),
    userAlias: (repositoryPath: string): Promise<string> =>
      invoke('repo_user_alias', { repositoryPath }),
    createBranch: (req: CreateBranchRequest): Promise<CreateBranchResult> =>
      result('repo_create_branch', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    openPullRequest: (req: OpenPullRequestRequest): Promise<OpenPullRequestResult> =>
      result('repo_open_pull_request', { ...req }, (message) => ({
        ok: false,
        code: 'git-failed',
        message
      })),
    findActivePullRequest: (req: FindPullRequestRequest): Promise<FindPullRequestResult> =>
      result('repo_find_active_pull_request', { ...req }, (message) => ({
        ok: false,
        code: 'git-failed',
        message
      })),
    workingCopyStatus: (req: WorkingCopyStatusRequest): Promise<WorkingCopyStatusResult> =>
      result('repo_working_copy_status', { ...req }, (error) => ({ ok: false, error })),
    recentCommits: (req: RecentCommitsRequest): Promise<RecentCommitsResult> =>
      result('repo_recent_commits', { ...req }, (error) => ({ ok: false, error })),
    rebaseOnDefault: (req: RebaseOnDefaultRequest): Promise<RebaseOnDefaultResult> =>
      result('repo_rebase_on_default', { ...req }, (message) => ({
        ok: false,
        code: 'git-failed',
        message
      })),
    unpushedCommits: (req: UnpushedCommitsRequest): Promise<UnpushedCommitsResult> =>
      result('repo_unpushed_commits', { ...req }, (error) => ({ ok: false, error })),
    push: (req: PushRequest): Promise<PushResult> =>
      result('repo_push', { ...req }, (error) => ({ ok: false, error })),
    stageFiles: (req: StageFilesRequest): Promise<StageFilesResult> =>
      result('repo_stage_files', { ...req }, (error) => ({ ok: false, error })),
    unstageFiles: (req: UnstageFilesRequest): Promise<UnstageFilesResult> =>
      result('repo_unstage_files', { ...req }, (error) => ({ ok: false, error })),
    revertFiles: (req: RevertFilesRequest): Promise<RevertFilesResult> =>
      result('repo_revert_files', { ...req }, (error) => ({ ok: false, error })),
    discardAllChanges: (req: DiscardAllChangesRequest): Promise<DiscardAllChangesResult> =>
      result('repo_discard_all_changes', { ...req }, (error) => ({ ok: false, error })),
    commit: (req: CommitRequest): Promise<CommitResult> =>
      result('repo_commit', { ...req }, (error) => ({ ok: false, error })),
    worktreesOverview: (req: WorktreesOverviewRequest): Promise<WorktreesOverviewResult> =>
      result('repo_worktrees_overview', { ...req }, (error) => ({ ok: false, error })),
    listMyBranches: (req: MyBranchesRequest): Promise<MyBranchesResult> =>
      result('repo_list_my_branches', { ...req }, (error) => ({ ok: false, error })),
    branchWebUrl: (req: BranchWebUrlRequest): Promise<BranchWebUrlResult> =>
      result('repo_branch_web_url', { ...req }, () => ({ webUrl: null })),
    detectMergeState: (req: DetectMergeStateRequest): Promise<DetectMergeStateResult> =>
      result('repo_detect_merge_state', { ...req }, (error) => ({ ok: false, error }))
  },
  reviews: {
    openPrs: {
      ado: (req: RepoOpenPrsRequest): Promise<RepoOpenPrsResult> =>
        result('ado_repo_open_prs', { ...req }, (message) => ({
          ok: false,
          code: 'git-failed',
          message
        })),
      github: (req: RepoOpenPrsRequest): Promise<RepoOpenPrsResult> =>
        result('github_repo_open_prs', { ...req }, (message) => ({
          ok: false,
          code: 'gh-failed',
          message
        }))
    },
    prThreads: {
      ado: (req: RepoPrThreadsRequest): Promise<RepoPrThreadsResult> =>
        result('ado_pr_threads', { ...req }, (message) => ({
          ok: false,
          code: 'git-failed',
          message
        })),
      github: (req: RepoPrThreadsRequest): Promise<RepoPrThreadsResult> =>
        result('github_pr_threads', { ...req }, (message) => ({
          ok: false,
          code: 'gh-failed',
          message
        }))
    }
  },
  /**
   * In-app PR review workspace. Each entry pairs the Azure DevOps and GitHub commands for one
   * operation; `lib/pr-review.ts` picks the pair matching the repository's remote.
   */
  prReview: {
    detail: {
      ado: (req: PrReviewDetailRequest): Promise<PrReviewDetailResult> =>
        result('ado_pr_detail', { ...req }, (message) => adoFail(message)),
      github: (req: PrReviewDetailRequest): Promise<PrReviewDetailResult> =>
        result('github_pr_detail', { ...req }, (message) => ghFail(message))
    },
    changedFiles: {
      ado: (req: PrChangedFilesRequest): Promise<PrChangedFilesResult> =>
        result('ado_pr_changed_files', { ...req }, (message) => adoFail(message)),
      github: (req: PrChangedFilesRequest): Promise<PrChangedFilesResult> =>
        result('github_pr_changed_files', { ...req }, (message) => ghFail(message))
    },
    fileDiff: {
      ado: (req: PrFileDiffRequest): Promise<PrFileDiffResult> =>
        result('ado_pr_file_diff', { ...req }, (message) => adoFail(message)),
      github: (req: PrFileDiffRequest): Promise<PrFileDiffResult> =>
        result('github_pr_file_diff', { ...req }, (message) => ghFail(message))
    },
    fileContent: {
      ado: (req: PrFileContentRequest): Promise<PrFileContentResult> =>
        result('ado_pr_file_content', { ...req }, (message) => adoFail(message)),
      github: (req: PrFileContentRequest): Promise<PrFileContentResult> =>
        result('github_pr_file_content', { ...req }, (message) => ghFail(message))
    },
    createThread: {
      ado: (req: PrCreateThreadRequest): Promise<PrMutationResult> =>
        result('ado_pr_create_thread', { ...req }, (message) => adoFail(message)),
      github: (req: PrCreateThreadRequest): Promise<PrMutationResult> =>
        result('github_pr_create_thread', { ...req }, (message) => ghFail(message))
    },
    reply: {
      ado: (req: PrReplyRequest): Promise<PrMutationResult> =>
        result('ado_pr_reply', { ...req }, (message) => adoFail(message)),
      github: (req: PrReplyRequest): Promise<PrMutationResult> =>
        result('github_pr_reply', { ...req }, (message) => ghFail(message))
    },
    setThreadStatus: {
      ado: (req: PrSetThreadStatusRequest): Promise<PrMutationResult> =>
        result('ado_pr_set_thread_status', { ...req }, (message) => adoFail(message)),
      github: (req: PrSetThreadStatusRequest): Promise<PrMutationResult> =>
        result('github_pr_set_thread_status', { ...req }, (message) => ghFail(message))
    },
    setVote: {
      ado: (req: PrSetVoteRequest): Promise<PrMutationResult> =>
        result('ado_pr_set_vote', { ...req }, (message) => adoFail(message)),
      github: (req: PrSetVoteRequest): Promise<PrMutationResult> =>
        result('github_pr_set_vote', { ...req }, (message) => ghFail(message))
    }
  },
  system: {
    openInVSCode: (folderPath: string): Promise<LaunchResult> =>
      result('system_open_in_vscode', { folderPath }, (error) => ({ ok: false, error })),
    openInVSCodeScm: (folderPath: string): Promise<LaunchResult> =>
      result('system_open_in_vscode_scm', { folderPath }, (error) => ({ ok: false, error })),
    openInWindowsTerminal: (folderPath: string): Promise<LaunchResult> =>
      result('system_open_in_windows_terminal', { folderPath }, (error) => ({ ok: false, error })),
    openExternal: (url: string): Promise<LaunchResult> =>
      result('system_open_external', { url }, (error) => ({ ok: false, error })),
    openPath: (folderPath: string): Promise<LaunchResult> =>
      result('system_open_path', { folderPath }, (error) => ({ ok: false, error })),
    launchCopilotCli: (req: LaunchCopilotCliRequest): Promise<LaunchResult> =>
      result('system_launch_copilot_cli', { ...req }, (error) => ({ ok: false, error })),
    launchCopilotResume: (req: LaunchCopilotResumeRequest): Promise<LaunchResult> =>
      result('system_launch_copilot_resume', { ...req }, (error) => ({ ok: false, error })),
    getAppInfo: (): Promise<AppInfo> => invoke('system_get_app_info')
  },
  copilotHistory: {
    list: (): Promise<CopilotHistoryListResult> =>
      result('copilot_history_list', undefined, (message) => ({
        ok: false,
        reason: 'unreadable',
        message
      }))
  },
  sessions: {
    create: (req: CreateSessionRequest): Promise<CreateSessionResult> =>
      result('sessions_create', { req }, (error) => ({ ok: false, error })),
    list: (): Promise<CopilotSession[]> => invoke('sessions_list'),
    snapshot: async (id: string): Promise<DecodedSessionSnapshot | null> => {
      const snap = await invoke<SessionSnapshot | null>('sessions_snapshot', { id })
      if (!snap) return null
      return { session: snap.session, buffer: decodeB64(snap.bufferB64), lastSeq: snap.lastSeq }
    },
    kill: (id: string): Promise<void> => invoke('sessions_kill', { id }),
    sendInput: (id: string, data: string): Promise<void> => invoke('sessions_input', { id, data }),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      invoke('sessions_resize', { id, cols, rows }),
    onData: (cb: (event: SessionData) => void): (() => void) => {
      const unlisten = listen<SessionDataEvent>(SessionEvents.Data, (e) => {
        cb({ id: e.payload.id, seq: e.payload.seq, data: decodeB64(e.payload.dataB64) })
      })
      return () => {
        void unlisten.then((un) => un())
      }
    },
    onExit: (cb: (event: SessionExitEvent) => void): (() => void) => {
      const unlisten = listen<SessionExitEvent>(SessionEvents.Exit, (e) => cb(e.payload))
      return () => {
        void unlisten.then((un) => un())
      }
    }
  },
  chat: {
    listConversations: (): Promise<ChatConversation[]> => invoke('chat_list_conversations'),
    createConversation: (context?: ChatContext): Promise<ChatConversation> =>
      invoke('chat_create_conversation', { context }),
    updateContext: (conversationId: string, context?: ChatContext): Promise<ChatConversation> =>
      invoke('chat_update_context', { conversationId, context }),
    deleteConversation: (conversationId: string): Promise<void> =>
      invoke('chat_delete_conversation', { conversationId }),
    listMessages: (conversationId: string): Promise<ChatMessage[]> =>
      invoke('chat_list_messages', { conversationId }),
    send: (conversationId: string, prompt: string): Promise<ChatMessage> =>
      invoke('chat_send', { conversationId, prompt }),
    abort: (conversationId: string): Promise<void> => invoke('chat_abort', { conversationId }),
    onDelta: (cb: (event: ChatDeltaEvent) => void): (() => void) => {
      const unlisten = listen<ChatDeltaEvent>(ChatEvents.Delta, (event) => cb(event.payload))
      return () => void unlisten.then((un) => un())
    },
    onComplete: (cb: (event: ChatCompleteEvent) => void): (() => void) => {
      const unlisten = listen<ChatCompleteEvent>(ChatEvents.Complete, (event) => cb(event.payload))
      return () => void unlisten.then((un) => un())
    },
    onError: (cb: (event: ChatErrorEvent) => void): (() => void) => {
      const unlisten = listen<ChatErrorEvent>(ChatEvents.Error, (event) => cb(event.payload))
      return () => void unlisten.then((un) => un())
    }
  }
}

export type Api = typeof api

declare global {
  interface Window {
    api: Api
  }
}

window.api = api

export { api }
