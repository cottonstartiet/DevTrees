import * as React from 'react'
import { toast } from 'sonner'

import { useTaskBoard } from '@/contexts/task-board-context'
import {
  isTerminalSessionFinished,
  useTerminalSessions
} from '@/contexts/terminal-sessions-context'
import { buildCodeReviewPrompt } from '@/lib/copilot-code-review-prompt'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { saveTaskQueueSettings, TASK_QUEUE_SETTINGS_CHANGED_EVENT } from '@/lib/task-queue-settings'
import { claimTaskRun, setTaskCopilotSession } from '@/lib/tasks'
import { listWorktreesForRepository } from '@/lib/worktrees'
import { nativeKey, nativeSessionKeepsTaskQueueSlot } from '@shared/native-session'
import type { Repository } from '@shared/repository'
import {
  selectTaskQueueCandidates,
  taskLaunchInitialMode,
  type Task,
  type TaskStatus
} from '@shared/task'
import type { TaskQueueMode, TaskQueueSettings } from '@shared/settings'
import type { WorktreeStatusResult } from '@shared/worktree'

function worktreeLabel(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

interface UseTaskQueueOptions {
  repositories: Repository[]
  createWorktree: (repository: Repository, name: string) => Promise<boolean>
  refreshWorktreesFor: (repositoryId: string) => Promise<void>
  checkWorktreeStatus: (path: string) => Promise<WorktreeStatusResult>
}

export interface TaskQueueController {
  settings: TaskQueueSettings
  settingsBusy: boolean
  queuedCount: number
  runningCount: number
  failedCount: number
  setMode: (mode: TaskQueueMode) => Promise<void>
  startTask: (task: Task) => Promise<void>
  moveTask: (task: Task, status: TaskStatus, beforeId?: string | null) => Promise<void>
  reviewTask: (task: Task) => Promise<void>
  canReviewTask: (task: Task) => boolean
}

const DEFAULT_SETTINGS: TaskQueueSettings = { mode: 'manual', concurrency: 2 }

export function useTaskQueue({
  repositories,
  createWorktree,
  refreshWorktreesFor,
  checkWorktreeStatus
}: UseTaskQueueOptions): TaskQueueController {
  const { tasks, moveTask, setTaskLocal, setTaskQueueStatus, updateTask } = useTaskBoard()
  const {
    byId: terminalSessionsById,
    nativeById,
    nativeBusy,
    observationNow
  } = useTerminalSessions()
  const launchCopilot = useCopilotLauncher()
  const [settings, setSettings] = React.useState<TaskQueueSettings>(DEFAULT_SETTINGS)
  const [settingsBusy, setSettingsBusy] = React.useState(true)
  const settingsWriteRef = React.useRef(false)
  const dispatchingRef = React.useRef(new Map<string, string>())
  const reconcilingRef = React.useRef(new Set<string>())
  const settlingRef = React.useRef(new Set<string>())

  React.useEffect(() => {
    let active = true
    void window.api.settings
      .taskQueue()
      .then((value) => {
        if (active) setSettings(value)
      })
      .catch((error) => {
        console.error('[task-queue] failed to load settings:', error)
        if (active) toast.error('Could not load task queue settings. Using manual mode.')
      })
      .finally(() => {
        if (active) setSettingsBusy(false)
      })

    const onSettingsChanged = (event: Event): void => {
      const detail = (event as CustomEvent<TaskQueueSettings>).detail
      if (detail) setSettings(detail)
    }
    window.addEventListener(TASK_QUEUE_SETTINGS_CHANGED_EVENT, onSettingsChanged)
    return () => {
      active = false
      window.removeEventListener(TASK_QUEUE_SETTINGS_CHANGED_EVENT, onSettingsChanged)
    }
  }, [])

  const setMode = React.useCallback(
    async (mode: TaskQueueMode): Promise<void> => {
      if (settingsWriteRef.current || mode === settings.mode) return
      const previousSettings = settings
      const nextSettings = { ...settings, mode }
      settingsWriteRef.current = true
      setSettingsBusy(true)
      setSettings(nextSettings)
      try {
        await saveTaskQueueSettings(nextSettings)
      } catch (error) {
        console.error('[task-queue] failed to save settings:', error)
        setSettings(previousSettings)
        toast.error('Could not change task execution mode.')
      } finally {
        settingsWriteRef.current = false
        setSettingsBusy(false)
      }
    },
    [settings]
  )

  const materializeTaskWorktree = React.useCallback(
    async (task: Task): Promise<Task | null> => {
      const name = task.pendingWorktreeName
      if (!name) return task

      const repository = repositories.find((candidate) => candidate.id === task.repositoryId)
      if (!repository) {
        toast.error('The repository for this task is unavailable.')
        return null
      }

      try {
        let worktree = (await listWorktreesForRepository(repository.path)).find(
          (candidate) => !candidate.isMain && worktreeLabel(candidate.path) === name
        )
        if (!worktree) {
          const created = await createWorktree(repository, name)
          if (!created) return null
          worktree = (await listWorktreesForRepository(repository.path)).find(
            (candidate) => !candidate.isMain && worktreeLabel(candidate.path) === name
          )
        }
        if (!worktree) {
          toast.error('The new worktree was created but could not be resolved.')
          return null
        }

        const updated = await updateTask({
          id: task.id,
          title: task.title,
          description: task.description,
          repositoryId: task.repositoryId,
          repositoryName: task.repositoryName,
          repositoryPath: task.repositoryPath,
          worktreePath: worktree.path,
          worktreeBranch: worktree.branch,
          pendingWorktreeName: null
        })
        if (!updated) return null
        await refreshWorktreesFor(repository.id)
        return updated
      } catch (error) {
        console.error('[task-queue] failed to prepare planned worktree:', error)
        toast.error(
          error instanceof Error ? error.message : 'Could not prepare the worktree for this task.'
        )
        return null
      }
    },
    [createWorktree, refreshWorktreesFor, repositories, updateTask]
  )

  const ensureWorktree = React.useCallback(
    async (task: Task): Promise<boolean> => {
      const repository =
        repositories.find((candidate) => candidate.id === task.repositoryId) ?? null
      try {
        const status = await checkWorktreeStatus(task.worktreePath)
        const missing =
          (status.ok && status.folderMissing) || (!status.ok && status.error === 'not-found')
        if (!missing) return true
        if (!repository) {
          toast.error('The worktree for this task is missing and its repository is unavailable.')
          return false
        }
        const recreated = await createWorktree(repository, worktreeLabel(task.worktreePath))
        const after = recreated ? await checkWorktreeStatus(task.worktreePath) : null
        const stillMissing =
          !after || (after.ok && after.folderMissing) || (!after.ok && after.error === 'not-found')
        if (stillMissing) {
          toast.error('Could not recreate the missing worktree for this task.')
          return false
        }
      } catch (error) {
        console.error('[task-queue] worktree status check failed:', error)
      }
      return true
    },
    [checkWorktreeStatus, createWorktree, repositories]
  )

  const executeTask = React.useCallback(
    async (task: Task, foreground: boolean): Promise<void> => {
      if (dispatchingRef.current.has(task.id)) return
      dispatchingRef.current.set(task.id, task.executionTargetKey)
      let claimed = false
      const failExecution = async (): Promise<void> => {
        if (!claimed) return
        if (task.status === 'todo') await moveTask(task.id, 'todo')
        await setTaskQueueStatus(task.id, 'failed')
      }
      try {
        const resolvedTask = await materializeTaskWorktree(task)
        if (!resolvedTask) {
          await setTaskQueueStatus(task.id, 'failed')
          return
        }
        dispatchingRef.current.set(task.id, resolvedTask.executionTargetKey)

        const linkedId = resolvedTask.copilotSessionId
        const linkedTerminal = linkedId ? terminalSessionsById[linkedId] : undefined
        if (
          task.status === 'todo' &&
          linkedTerminal != null &&
          !isTerminalSessionFinished(linkedTerminal.status)
        ) {
          toast.info('A Copilot session for this task is already running.')
          await failExecution()
          return
        }
        if (task.status === 'review' && linkedId) {
          const linkedIsRunning = linkedTerminal
            ? !isTerminalSessionFinished(linkedTerminal.status) && linkedTerminal.status !== 'idle'
            : await window.api.terminalSessions.isRunning(linkedId)
          if (linkedIsRunning) {
            toast.info('End the task session before starting its review.')
            await failExecution()
            return
          }
        }

        if (!(await ensureWorktree(resolvedTask))) {
          await setTaskQueueStatus(task.id, 'failed')
          return
        }

        const claim = await claimTaskRun({ id: resolvedTask.id })
        if (!claim.ok) {
          if (claim.error === 'target-busy') {
            if (foreground)
              toast.info(claim.message ?? 'Another task is already using this worktree.')
            return
          }
          toast.error(claim.message ?? 'Could not reserve this worktree for the task.')
          return
        }
        claimed = true
        setTaskLocal(claim.task)

        if (task.status === 'todo') {
          await moveTask(task.id, 'in_progress')
        }

        const claimedTask = { ...resolvedTask, queueStatus: 'running' as const }

        const isReview = task.status === 'review'
        const prompt = isReview
          ? buildCodeReviewPrompt({
              kind: 'task',
              folderPath: claimedTask.worktreePath,
              taskTitle: claimedTask.title,
              taskDescription: claimedTask.description,
              repositoryName: claimedTask.repositoryName,
              branch: claimedTask.worktreeBranch
            })
          : [claimedTask.title.trim(), claimedTask.description.trim()].filter(Boolean).join('\n\n')
        const result = await launchCopilot({
          folderPath: claimedTask.worktreePath,
          prompt,
          initialMode: taskLaunchInitialMode(task.status),
          label: isReview
            ? `Review: ${claimedTask.title.trim() || claimedTask.repositoryName}`
            : claimedTask.title.trim() || claimedTask.repositoryName,
          branch: claimedTask.worktreeBranch ?? undefined,
          repository: claimedTask.repositoryName,
          taskId: claimedTask.id,
          background: !foreground
        })

        if (!result.ok) {
          toast.error(
            result.error ||
              (isReview
                ? 'Could not start the code review for this task.'
                : 'Could not start a Copilot session for this task.')
          )
          await failExecution()
          return
        }

        const runningTask = {
          ...claimedTask,
          status: isReview ? ('review' as const) : ('in_progress' as const),
          copilotSessionId: result.sessionId,
          queueStatus: 'running' as const
        }
        setTaskLocal(runningTask)
        const linked = await setTaskCopilotSession({
          id: claimedTask.id,
          copilotSessionId: result.sessionId
        })
        if (linked.ok) setTaskLocal({ ...linked.task, queueStatus: 'running' })
        else toast.error(linked.message ?? 'Could not link the session to this task.')

        toast.success(
          isReview
            ? `Code review started for "${claimedTask.title}".`
            : `Copilot started for "${claimedTask.title}".`
        )
      } catch (error) {
        console.error('[task-queue] task execution failed:', error)
        toast.error(error instanceof Error ? error.message : 'Could not execute the queued task.')
        await failExecution()
      } finally {
        dispatchingRef.current.delete(task.id)
      }
    },
    [
      ensureWorktree,
      launchCopilot,
      materializeTaskWorktree,
      moveTask,
      setTaskLocal,
      setTaskQueueStatus,
      terminalSessionsById
    ]
  )

  const queuedTasks = React.useMemo(
    () =>
      tasks
        .filter(
          (task) =>
            (task.status === 'todo' || task.status === 'review') && task.queueStatus === 'queued'
        )
        .sort((a, b) => a.queueOrder - b.queueOrder),
    [tasks]
  )
  const failedTasks = React.useMemo(
    () =>
      tasks
        .filter(
          (task) =>
            (task.status === 'todo' || task.status === 'review') && task.queueStatus === 'failed'
        )
        .sort((a, b) => a.queueOrder - b.queueOrder),
    [tasks]
  )
  const runningTasks = React.useMemo(
    () => tasks.filter((task) => task.queueStatus === 'running'),
    [tasks]
  )

  React.useEffect(() => {
    if (settingsBusy || settings.mode !== 'automatic') return
    const available = settings.concurrency - runningTasks.length - dispatchingRef.current.size
    if (available <= 0) return
    const selected = selectTaskQueueCandidates(
      queuedTasks,
      runningTasks,
      dispatchingRef.current.values(),
      available
    )
    for (const task of selected) {
      void executeTask(task, false)
    }
  }, [executeTask, queuedTasks, runningTasks, settings, settingsBusy])

  React.useEffect(() => {
    for (const task of runningTasks) {
      if (
        dispatchingRef.current.has(task.id) ||
        reconcilingRef.current.has(task.id) ||
        settlingRef.current.has(task.id)
      ) {
        continue
      }
      const settleTask = async (queueStatus: 'complete' | 'failed'): Promise<void> => {
        if (queueStatus === 'failed' && task.status === 'in_progress') {
          await moveTask(task.id, 'todo')
        }
        await setTaskQueueStatus(task.id, queueStatus)
      }
      const sessionId = task.copilotSessionId
      if (!sessionId) {
        settlingRef.current.add(task.id)
        void settleTask('failed').finally(() => {
          settlingRef.current.delete(task.id)
        })
        continue
      }
      const session = terminalSessionsById[sessionId]
      if (session?.status === 'idle' || session?.status === 'done') {
        const planTransitionBusy = nativeBusy[nativeKey(session, 'plan-transition')] === true
        if (
          session.status === 'idle' &&
          nativeSessionKeepsTaskQueueSlot(session, nativeById[sessionId], planTransitionBusy)
        ) {
          continue
        }
        settlingRef.current.add(task.id)
        void settleTask('complete').finally(() => {
          settlingRef.current.delete(task.id)
        })
        continue
      }
      if (session?.status === 'error') {
        settlingRef.current.add(task.id)
        void settleTask('failed').finally(() => {
          settlingRef.current.delete(task.id)
        })
        continue
      }
      if (session) continue

      reconcilingRef.current.add(task.id)
      void window.api.terminalSessions
        .isRunning(sessionId)
        .then((isRunning) => {
          if (!isRunning) void setTaskQueueStatus(task.id, 'complete')
        })
        .catch((error) => {
          console.error('[task-queue] failed to reconcile task session:', error)
        })
        .finally(() => {
          reconcilingRef.current.delete(task.id)
        })
    }
  }, [
    moveTask,
    nativeBusy,
    nativeById,
    observationNow,
    runningTasks,
    setTaskQueueStatus,
    terminalSessionsById
  ])

  const canReviewTask = React.useCallback(
    (task: Task): boolean => {
      if (task.status !== 'in_progress' || task.queueStatus === 'running') return false
      const linkedId = task.copilotSessionId
      if (!linkedId) return false
      const session = terminalSessionsById[linkedId]
      if (!session) return true
      return isTerminalSessionFinished(session.status) || session.status === 'idle'
    },
    [terminalSessionsById]
  )

  const hasAvailableSlot = React.useCallback((): boolean => {
    if (runningTasks.length + dispatchingRef.current.size < settings.concurrency) return true
    toast.info(
      `${settings.concurrency} ${settings.concurrency === 1 ? 'task is' : 'tasks are'} already running. Finish one before starting another.`
    )
    return false
  }, [runningTasks.length, settings.concurrency])

  const hasAvailableTarget = React.useCallback(
    (task: Task): boolean => {
      const busy =
        runningTasks.some(
          (running) =>
            running.id !== task.id && running.executionTargetKey === task.executionTargetKey
        ) ||
        Array.from(dispatchingRef.current.entries()).some(
          ([id, target]) => id !== task.id && target === task.executionTargetKey
        )
      if (!busy) return true
      toast.info('Another task is already using this repository worktree.')
      return false
    },
    [runningTasks]
  )

  const startTask = React.useCallback(
    async (task: Task): Promise<void> => {
      if (task.status !== 'todo') return
      if (!hasAvailableSlot()) return
      if (!hasAvailableTarget(task)) return
      await executeTask(task, true)
    },
    [executeTask, hasAvailableSlot, hasAvailableTarget]
  )

  const handleMoveTask = React.useCallback(
    async (task: Task, status: TaskStatus, beforeId?: string | null): Promise<void> => {
      const startsTask =
        settings.mode === 'manual' && task.status === 'todo' && status === 'in_progress'
      const startsReview =
        settings.mode === 'manual' && task.status === 'in_progress' && status === 'review'

      if (startsTask) {
        await startTask(task)
        return
      }

      if (startsReview) {
        if (!canReviewTask(task)) {
          toast.info('Finish the task session before moving it to Review.')
          return
        }
        if (!hasAvailableSlot()) return
        if (!hasAvailableTarget(task)) return
        await moveTask(task.id, 'review', beforeId)
        await executeTask({ ...task, status: 'review' }, true)
        return
      }

      await moveTask(task.id, status, beforeId)
    },
    [
      canReviewTask,
      executeTask,
      hasAvailableSlot,
      hasAvailableTarget,
      moveTask,
      settings.mode,
      startTask
    ]
  )

  const reviewTask = React.useCallback(
    async (task: Task): Promise<void> => {
      await handleMoveTask(task, 'review')
    },
    [handleMoveTask]
  )

  return {
    settings,
    settingsBusy,
    queuedCount: queuedTasks.length,
    runningCount: runningTasks.length,
    failedCount: failedTasks.length,
    setMode,
    startTask,
    moveTask: handleMoveTask,
    reviewTask,
    canReviewTask
  }
}
