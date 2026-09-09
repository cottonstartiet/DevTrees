import * as React from 'react'
import { toast } from 'sonner'

import { useTaskBoard } from '@/contexts/task-board-context'
import {
  isTerminalSessionFinished,
  useTerminalSessions
} from '@/contexts/terminal-sessions-context'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { buildTaskCodeReviewPrompt } from '@/lib/copilot-task-review-prompt'
import { setTaskCopilotSession } from '@/lib/tasks'
import { listWorktreesForRepository } from '@/lib/worktrees'
import type { Repository } from '@shared/repository'
import type { Task, TaskStatus } from '@shared/task'
import type { TaskQueueSettings } from '@shared/settings'
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
  queuedCount: number
  runningCount: number
  failedCount: number
  manualRunActive: boolean
  runQueue: () => void
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
  const { byId: terminalSessionsById, observationNow } = useTerminalSessions()
  const launchCopilot = useCopilotLauncher()
  const [settings, setSettings] = React.useState<TaskQueueSettings>(DEFAULT_SETTINGS)
  const [manualRunActive, setManualRunActive] = React.useState(false)
  const dispatchingRef = React.useRef(new Set<string>())
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

    const onSettingsChanged = (event: Event): void => {
      const detail = (event as CustomEvent<TaskQueueSettings>).detail
      if (detail) setSettings(detail)
    }
    window.addEventListener('task-queue-settings-changed', onSettingsChanged)
    return () => {
      active = false
      window.removeEventListener('task-queue-settings-changed', onSettingsChanged)
    }
  }, [])

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
      dispatchingRef.current.add(task.id)
      const failExecution = async (): Promise<void> => {
        if (task.status === 'todo') await moveTask(task.id, 'todo')
        await setTaskQueueStatus(task.id, 'failed')
      }
      try {
        const queuedTask = await setTaskQueueStatus(task.id, 'running')
        if (!queuedTask) return

        if (task.status === 'todo') {
          await moveTask(task.id, 'in_progress')
        }

        const resolvedTask = await materializeTaskWorktree(queuedTask)
        if (!resolvedTask) {
          await failExecution()
          return
        }

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
          await failExecution()
          return
        }

        const isReview = task.status === 'review'
        const prompt = isReview
          ? buildTaskCodeReviewPrompt({
              folderPath: resolvedTask.worktreePath,
              taskTitle: resolvedTask.title,
              taskDescription: resolvedTask.description,
              repositoryName: resolvedTask.repositoryName,
              branch: resolvedTask.worktreeBranch
            })
          : [resolvedTask.title.trim(), resolvedTask.description.trim()]
              .filter(Boolean)
              .join('\n\n')
        const result = await launchCopilot({
          folderPath: resolvedTask.worktreePath,
          prompt,
          initialMode: isReview ? undefined : 'plan',
          label: isReview
            ? `Review: ${resolvedTask.title.trim() || resolvedTask.repositoryName}`
            : resolvedTask.title.trim() || resolvedTask.repositoryName,
          branch: resolvedTask.worktreeBranch ?? undefined,
          repository: resolvedTask.repositoryName,
          taskId: resolvedTask.id,
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
          ...resolvedTask,
          status: isReview ? ('review' as const) : ('in_progress' as const),
          copilotSessionId: result.sessionId,
          queueStatus: 'running' as const
        }
        setTaskLocal(runningTask)
        const linked = await setTaskCopilotSession({
          id: resolvedTask.id,
          copilotSessionId: result.sessionId
        })
        if (linked.ok) setTaskLocal({ ...linked.task, queueStatus: 'running' })
        else toast.error(linked.message ?? 'Could not link the session to this task.')

        toast.success(
          isReview
            ? `Code review started for "${resolvedTask.title}".`
            : `Copilot started for "${resolvedTask.title}".`
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
    const shouldDrain = settings.mode === 'automatic' || manualRunActive
    if (!shouldDrain) return
    const available = settings.concurrency - runningTasks.length - dispatchingRef.current.size
    if (available <= 0) return
    for (const task of queuedTasks.slice(0, available)) {
      void executeTask(task, false)
    }
  }, [executeTask, manualRunActive, queuedTasks, runningTasks.length, settings])

  React.useEffect(() => {
    if (
      manualRunActive &&
      queuedTasks.length === 0 &&
      runningTasks.length === 0 &&
      dispatchingRef.current.size === 0
    ) {
      setManualRunActive(false)
    }
  }, [manualRunActive, queuedTasks.length, runningTasks.length])

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
  }, [moveTask, observationNow, runningTasks, setTaskQueueStatus, terminalSessionsById])

  const handleMoveTask = React.useCallback(
    async (task: Task, status: TaskStatus, beforeId?: string | null): Promise<void> => {
      const movePromise = moveTask(task.id, status, beforeId)
      if (status === 'in_progress') await materializeTaskWorktree(task)
      await movePromise
    },
    [materializeTaskWorktree, moveTask]
  )

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

  const reviewTask = React.useCallback(
    async (task: Task): Promise<void> => {
      await moveTask(task.id, 'review')
    },
    [moveTask]
  )

  return {
    settings,
    queuedCount: queuedTasks.length,
    runningCount: runningTasks.length,
    failedCount: failedTasks.length,
    manualRunActive,
    runQueue: () => {
      void Promise.all(failedTasks.map((task) => setTaskQueueStatus(task.id, 'queued'))).then(() =>
        setManualRunActive(true)
      )
    },
    startTask: async (task) => {
      if (runningTasks.length + dispatchingRef.current.size >= settings.concurrency) {
        toast.info(`The task queue is already using all ${settings.concurrency} slots.`)
        return
      }
      await executeTask(task, true)
    },
    moveTask: handleMoveTask,
    reviewTask,
    canReviewTask
  }
}
