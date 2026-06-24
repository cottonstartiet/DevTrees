import * as React from 'react'
import { toast } from 'sonner'

import { type CommitDialogMode } from '@/components/commit-dialog'
import { useTasks } from '@/contexts/tasks-context'
import { useUnpushedCommits } from '@/hooks/use-unpushed-commits'
import {
  useWorkingCopyStatus,
  type UseWorkingCopyStatusResult
} from '@/hooks/use-working-copy-status'
import {
  detectMergeState,
  discardAllChanges,
  commit,
  pushBranch,
  pullCurrentBranch,
  rebaseOnDefault,
  revertFiles,
  stageFiles,
  unstageFiles
} from '@/lib/repo'
import { launchCopilotCli, openInVSCode, openInVSCodeScm, openPath } from '@/lib/system'
import { buildConflictsPrompt } from '@/lib/copilot-conflicts-prompt'
import type { RebaseOnDefaultResult, WorkingCopyEntry } from '@shared/repo'

export interface UseWorkingCopyControllerArgs {
  folderPath: string | null
  branch: string | null
  defaultBranch: string | null
}

export interface WorkingCopyController {
  folderPath: string | null
  branch: string | null
  defaultBranch: string | null
  data: UseWorkingCopyStatusResult['data']
  error: string | null
  isLoading: boolean
  refresh: () => Promise<void>
  description: string
  entries: WorkingCopyEntry[]
  stagedRows: WorkingCopyEntry[]
  changedRows: WorkingCopyEntry[]
  untrackedRows: WorkingCopyEntry[]
  conflictedRows: WorkingCopyEntry[]
  conflictedCount: number
  pending: Set<string>
  handleStage: (entry: WorkingCopyEntry) => Promise<void>
  handleUnstage: (entry: WorkingCopyEntry) => Promise<void>
  handleStageAll: (entries: WorkingCopyEntry[]) => Promise<void>
  handleUnstageAll: (entries: WorkingCopyEntry[]) => Promise<void>
  handleRevert: (entry: WorkingCopyEntry) => Promise<void>
  handleOpenFile: (entry: WorkingCopyEntry) => Promise<void>
  handleOpenAllInVSCode: () => Promise<void>
  isPushing: boolean
  handlePush: () => Promise<void>
  isPullingCurrent: boolean
  handlePullCurrent: () => Promise<void>
  showPullCurrent: boolean
  pullCurrentDisabled: boolean
  isRebasing: boolean
  handleRebase: () => Promise<void>
  isDiscarding: boolean
  handleDiscardAll: () => Promise<void>
  discardDisabled: boolean
  commitMode: CommitDialogMode | null
  setCommitMode: (mode: CommitDialogMode | null) => void
  handleCommitted: () => void
  handleCommitInBackground: (message: string, mode: CommitDialogMode) => void
  isCommitting: boolean
  showPush: boolean
  showRebase: boolean
  pushDisabled: boolean
  rebaseDisabled: boolean
  commitStagedDisabled: boolean
  commitAllDisabled: boolean
  hasPending: boolean
  stagedCount: number
  unpushedCount: number
  isResolvingConflicts: boolean
  handleResolveConflicts: () => Promise<void>
  showResolveConflicts: boolean
  resolveConflictsDisabled: boolean
}

export function useWorkingCopyController({
  folderPath,
  branch,
  defaultBranch
}: UseWorkingCopyControllerArgs): WorkingCopyController {
  const { data, error, isLoading, refresh } = useWorkingCopyStatus(folderPath, folderPath !== null)
  const { data: unpushedData, refresh: refreshUnpushed } = useUnpushedCommits(
    folderPath,
    branch,
    folderPath !== null && branch !== null
  )
  const { startTask, succeedTask, failTask } = useTasks()
  const [pending, setPending] = React.useState<Set<string>>(() => new Set())
  const [commitMode, setCommitMode] = React.useState<CommitDialogMode | null>(null)
  const [isPushing, setIsPushing] = React.useState(false)
  const [isPullingCurrent, setIsPullingCurrent] = React.useState(false)
  const [isRebasing, setIsRebasing] = React.useState(false)
  const [isDiscarding, setIsDiscarding] = React.useState(false)
  const [isCommitting, setIsCommitting] = React.useState(false)
  const [isResolvingConflicts, setIsResolvingConflicts] = React.useState(false)

  const entries = React.useMemo(() => data?.entries ?? [], [data])
  const stagedCount = data?.staged ?? 0
  const totalChanges = entries.length

  const stagedRows = React.useMemo(() => entries.filter((e) => e.isStaged), [entries])
  const changedRows = React.useMemo(
    () => entries.filter((e) => e.isUnstaged && !e.isUntracked),
    [entries]
  )
  const untrackedRows = React.useMemo(() => entries.filter((e) => e.isUntracked), [entries])
  const conflictedRows = React.useMemo(() => entries.filter(isConflictedEntry), [entries])
  const conflictedCount = conflictedRows.length

  const description = data
    ? totalChanges === 0
      ? 'Working tree is clean.'
      : conflictedCount > 0
        ? `${totalChanges} file${totalChanges === 1 ? '' : 's'} changed (${conflictedCount} in conflict).`
        : `${totalChanges} file${totalChanges === 1 ? '' : 's'} changed in the working tree.`
    : isLoading
      ? 'Reading working copy…'
      : 'Working copy not loaded.'

  const markPending = React.useCallback((path: string, on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const handleStage = React.useCallback(
    async (entry: WorkingCopyEntry): Promise<void> => {
      if (!folderPath) return
      const key = entry.path
      const files = entry.originalPath ? [entry.originalPath, entry.path] : [entry.path]
      markPending(key, true)
      try {
        const result = await stageFiles({ folderPath, files })
        if (!result.ok) {
          toast.error(result.error || 'Stage failed.')
          return
        }
        void refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Stage failed.')
      } finally {
        markPending(key, false)
      }
    },
    [folderPath, markPending, refresh]
  )

  const handleUnstage = React.useCallback(
    async (entry: WorkingCopyEntry): Promise<void> => {
      if (!folderPath) return
      const key = entry.path
      const files = entry.originalPath ? [entry.originalPath, entry.path] : [entry.path]
      markPending(key, true)
      try {
        const result = await unstageFiles({ folderPath, files })
        if (!result.ok) {
          toast.error(result.error || 'Unstage failed.')
          return
        }
        void refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Unstage failed.')
      } finally {
        markPending(key, false)
      }
    },
    [folderPath, markPending, refresh]
  )

  const handleStageAll = React.useCallback(
    async (rows: WorkingCopyEntry[]): Promise<void> => {
      if (!folderPath || rows.length === 0) return
      const keys = rows.map((e) => e.path)
      const files = rows.flatMap((e) => (e.originalPath ? [e.originalPath, e.path] : [e.path]))
      keys.forEach((key) => markPending(key, true))
      try {
        const result = await stageFiles({ folderPath, files })
        if (!result.ok) {
          toast.error(result.error || 'Stage failed.')
          return
        }
        void refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Stage failed.')
      } finally {
        keys.forEach((key) => markPending(key, false))
      }
    },
    [folderPath, markPending, refresh]
  )

  const handleUnstageAll = React.useCallback(
    async (rows: WorkingCopyEntry[]): Promise<void> => {
      if (!folderPath || rows.length === 0) return
      const keys = rows.map((e) => e.path)
      const files = rows.flatMap((e) => (e.originalPath ? [e.originalPath, e.path] : [e.path]))
      keys.forEach((key) => markPending(key, true))
      try {
        const result = await unstageFiles({ folderPath, files })
        if (!result.ok) {
          toast.error(result.error || 'Unstage failed.')
          return
        }
        void refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Unstage failed.')
      } finally {
        keys.forEach((key) => markPending(key, false))
      }
    },
    [folderPath, markPending, refresh]
  )

  const handleRevert = React.useCallback(
    async (entry: WorkingCopyEntry): Promise<void> => {
      if (!folderPath) return
      const key = entry.path
      const files = entry.originalPath ? [entry.originalPath, entry.path] : [entry.path]
      markPending(key, true)
      try {
        const result = await revertFiles({ folderPath, files, isUntracked: entry.isUntracked })
        if (!result.ok) {
          toast.error(result.error || 'Revert failed.')
          return
        }
        void refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Revert failed.')
      } finally {
        markPending(key, false)
      }
    },
    [folderPath, markPending, refresh]
  )

  const hasPending = pending.size > 0
  const unpushedCount = unpushedData?.commits.length ?? 0

  const handleOpenFile = React.useCallback(
    async (entry: WorkingCopyEntry): Promise<void> => {
      if (!folderPath) return
      const relative = entry.path.replace(/\//g, '\\')
      const separator = folderPath.endsWith('\\') ? '' : '\\'
      const absolutePath = `${folderPath}${separator}${relative}`
      try {
        const result = await openPath(absolutePath)
        if (!result.ok) {
          toast.error(result.error || 'Could not open file.')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not open file.')
      }
    },
    [folderPath]
  )

  const handleOpenAllInVSCode = React.useCallback(async (): Promise<void> => {
    if (!folderPath) return
    try {
      const result = await openInVSCodeScm(folderPath)
      if (!result.ok) {
        toast.error(result.error || 'Could not open VS Code.')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open VS Code.')
    }
  }, [folderPath])

  const handlePush = React.useCallback(async (): Promise<void> => {
    if (!folderPath || !branch) return
    setIsPushing(true)
    const taskId = startTask(`Pushing ${branch}`)
    try {
      const result = await pushBranch({ folderPath })
      if (result.ok) {
        succeedTask(taskId)
        toast.success(`Pushed ${branch} to origin.`)
        await Promise.all([refresh(), refreshUnpushed()])
      } else {
        failTask(taskId, result.error)
        toast.error(`Push failed: ${result.error}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Push failed.'
      failTask(taskId, message)
      toast.error(message)
    } finally {
      setIsPushing(false)
    }
  }, [branch, folderPath, refresh, refreshUnpushed, startTask, succeedTask, failTask])

  const handlePullCurrent = React.useCallback(async (): Promise<void> => {
    if (!folderPath || !branch) return
    setIsPullingCurrent(true)
    const taskId = startTask(`Pulling ${branch}`)
    try {
      const result = await pullCurrentBranch(folderPath)
      if (result.ok) {
        succeedTask(taskId)
        if (result.alreadyUpToDate) {
          toast.success(`${branch} is already up to date.`)
        } else {
          toast.success(`Pulled latest into ${branch}.`)
        }
        await Promise.all([refresh(), refreshUnpushed()])
      } else {
        failTask(taskId, result.error)
        toast.error(`Pull failed: ${result.error}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Pull failed.'
      failTask(taskId, message)
      toast.error(message)
    } finally {
      setIsPullingCurrent(false)
    }
  }, [branch, folderPath, refresh, refreshUnpushed, startTask, succeedTask, failTask])

  const handleRebase = React.useCallback(async (): Promise<void> => {
    if (!folderPath || !branch || !defaultBranch || branch === defaultBranch) return
    setIsRebasing(true)
    const taskId = startTask(`Rebasing ${branch} on origin/${defaultBranch}`)
    try {
      const result = await rebaseOnDefault({ folderPath })
      if (result.ok) {
        succeedTask(taskId)
        toast.success(`Rebased on origin/${defaultBranch}.`)
        await Promise.all([refresh(), refreshUnpushed()])
      } else {
        failTask(taskId, result.message ?? result.code)
        showRebaseError(result, folderPath, defaultBranch)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Rebase failed.'
      failTask(taskId, message)
      toast.error(message)
    } finally {
      setIsRebasing(false)
    }
  }, [
    branch,
    defaultBranch,
    folderPath,
    refresh,
    refreshUnpushed,
    startTask,
    succeedTask,
    failTask
  ])

  const handleCommitted = React.useCallback((): void => {
    void refresh()
    void refreshUnpushed()
  }, [refresh, refreshUnpushed])

  const handleCommitInBackground = React.useCallback(
    (message: string, mode: CommitDialogMode): void => {
      if (!folderPath) return
      const trimmed = message.trim()
      if (!trimmed) return
      const label = mode === 'all' ? 'Committing all changes' : 'Committing staged changes'
      const taskId = startTask(label)
      setIsCommitting(true)
      void (async () => {
        try {
          const result = await commit({ folderPath, message: trimmed, stageAll: mode === 'all' })
          if (result.ok) {
            succeedTask(taskId)
            toast.success(`Committed ${result.commitSha.slice(0, 7)}`)
            handleCommitted()
          } else if (result.code === 'nothing-to-commit') {
            failTask(taskId, result.error)
            toast.message('Nothing to commit.')
          } else {
            failTask(taskId, result.error)
            toast.error(`Commit failed: ${result.error}`)
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'commit failed'
          failTask(taskId, errorMessage)
          toast.error(errorMessage)
        } finally {
          setIsCommitting(false)
        }
      })()
    },
    [folderPath, startTask, succeedTask, failTask, handleCommitted]
  )

  const handleDiscardAll = React.useCallback(async (): Promise<void> => {
    if (!folderPath) return
    setIsDiscarding(true)
    const taskId = startTask('Discarding all local changes')
    try {
      const result = await discardAllChanges({ folderPath })
      if (result.ok) {
        succeedTask(taskId)
        toast.success('Discarded all local changes.')
        await Promise.all([refresh(), refreshUnpushed()])
      } else {
        failTask(taskId, result.error)
        toast.error(`Discard failed: ${result.error}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Discard failed.'
      failTask(taskId, message)
      toast.error(message)
    } finally {
      setIsDiscarding(false)
    }
  }, [folderPath, refresh, refreshUnpushed, startTask, succeedTask, failTask])

  const handleResolveConflicts = React.useCallback(async (): Promise<void> => {
    if (!folderPath || conflictedRows.length === 0) return
    setIsResolvingConflicts(true)
    try {
      const stateResult = await detectMergeState({ folderPath })
      const mergeState = stateResult.ok ? stateResult.state : 'none'
      const rebaseHeadName = stateResult.ok ? stateResult.rebaseHeadName : undefined
      const rebaseOnto = stateResult.ok ? stateResult.rebaseOnto : undefined
      const mergeHeads = stateResult.ok ? stateResult.mergeHeads : undefined

      const prompt = buildConflictsPrompt({
        folderPath,
        branch,
        defaultBranch,
        conflictedFiles: conflictedRows.map((e) => ({
          path: e.path,
          indexStatus: e.indexStatus,
          worktreeStatus: e.worktreeStatus
        })),
        mergeState,
        rebaseHeadName,
        rebaseOnto,
        mergeHeads
      })

      const launchResult = await launchCopilotCli({ folderPath, prompt })
      if (launchResult.ok) {
        toast.success('Copilot CLI launched in Windows Terminal.')
      } else {
        toast.error(`Could not launch Copilot CLI: ${launchResult.error}`)
      }
    } catch (err) {
      toast.error(
        `Could not launch Copilot CLI: ${err instanceof Error ? err.message : 'unknown error'}`
      )
    } finally {
      setIsResolvingConflicts(false)
    }
  }, [folderPath, branch, defaultBranch, conflictedRows])

  const showPush = branch !== null && folderPath !== null
  const showPullCurrent = branch !== null && folderPath !== null
  const showRebase =
    folderPath !== null && branch !== null && defaultBranch !== null && branch !== defaultBranch
  const pushDisabled =
    hasPending ||
    isPushing ||
    isPullingCurrent ||
    isRebasing ||
    isDiscarding ||
    isCommitting ||
    unpushedCount === 0
  const pullCurrentDisabled =
    hasPending ||
    isPushing ||
    isPullingCurrent ||
    isRebasing ||
    isDiscarding ||
    isCommitting ||
    conflictedCount > 0
  const rebaseDisabled =
    hasPending || isPushing || isPullingCurrent || isRebasing || isDiscarding || isCommitting
  const commitStagedDisabled =
    hasPending ||
    isPushing ||
    isPullingCurrent ||
    isRebasing ||
    isDiscarding ||
    isCommitting ||
    !data ||
    stagedCount === 0
  const commitAllDisabled =
    hasPending ||
    isPushing ||
    isPullingCurrent ||
    isRebasing ||
    isDiscarding ||
    isCommitting ||
    !data ||
    entries.length === 0
  const discardDisabled =
    hasPending ||
    isPushing ||
    isPullingCurrent ||
    isRebasing ||
    isDiscarding ||
    isCommitting ||
    !data ||
    entries.length === 0
  const showResolveConflicts = conflictedCount > 0
  const resolveConflictsDisabled =
    hasPending ||
    isPushing ||
    isPullingCurrent ||
    isRebasing ||
    isDiscarding ||
    isCommitting ||
    isResolvingConflicts

  return {
    folderPath,
    branch,
    defaultBranch,
    data,
    error,
    isLoading,
    refresh,
    description,
    entries,
    stagedRows,
    changedRows,
    untrackedRows,
    conflictedRows,
    conflictedCount,
    pending,
    handleStage,
    handleUnstage,
    handleStageAll,
    handleUnstageAll,
    handleRevert,
    handleOpenFile,
    handleOpenAllInVSCode,
    isPushing,
    handlePush,
    isPullingCurrent,
    handlePullCurrent,
    showPullCurrent,
    pullCurrentDisabled,
    isRebasing,
    handleRebase,
    isDiscarding,
    handleDiscardAll,
    discardDisabled,
    commitMode,
    setCommitMode,
    handleCommitted,
    handleCommitInBackground,
    isCommitting,
    showPush,
    showRebase,
    pushDisabled,
    rebaseDisabled,
    commitStagedDisabled,
    commitAllDisabled,
    hasPending,
    stagedCount,
    unpushedCount,
    isResolvingConflicts,
    handleResolveConflicts,
    showResolveConflicts,
    resolveConflictsDisabled
  }
}

function isConflictedEntry(e: WorkingCopyEntry): boolean {
  const x = e.indexStatus
  const y = e.worktreeStatus
  if (x === 'U' || y === 'U') return true
  if (x === 'A' && y === 'A') return true
  if (x === 'D' && y === 'D') return true
  return false
}

function showRebaseError(
  result: Extract<RebaseOnDefaultResult, { ok: false }>,
  folderPath: string,
  defaultBranch: string
): void {
  switch (result.code) {
    case 'dirty':
      toast.error('Commit or stash your local changes first.')
      return
    case 'conflicts':
      toast.error('Rebase paused with conflicts — use the ✨ Resolve button or open VS Code.', {
        action: {
          label: 'Open in VS Code',
          onClick: () => {
            void openInVSCode(folderPath)
          }
        }
      })
      return
    case 'fetch-failed':
      toast.error(`Could not fetch origin: ${result.message ?? 'fetch failed'}`)
      return
    case 'pull-failed':
      toast.error(`Could not fast-forward ${defaultBranch}: ${result.message ?? 'pull failed'}`)
      return
    case 'rebase-failed':
      toast.error(`Rebase failed: ${result.message ?? 'rebase failed'}`)
      return
    case 'no-default-branch':
      toast.error('Could not determine the default branch.')
      return
    case 'git-failed':
    default:
      toast.error(result.message ?? 'Git command failed.')
  }
}
