/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { toast } from 'sonner'

import {
  createTask,
  deleteTask,
  listTasks,
  moveTask,
  setTaskQueueStatus,
  updateTask
} from '@/lib/tasks'
import { moveTaskOptimistically, reconcileTaskList } from '@/lib/task-state'
import type {
  CreateTaskRequest,
  Task,
  TaskQueueStatus,
  TaskStatus,
  UpdateTaskRequest
} from '@shared/task'

export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'review', 'done']

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done'
}

export interface TaskBoardContextValue {
  tasks: Task[]
  tasksByStatus: Record<TaskStatus, Task[]>
  loading: boolean
  createTask: (req: CreateTaskRequest) => Promise<Task | null>
  updateTask: (req: UpdateTaskRequest) => Promise<Task | null>
  moveTask: (
    id: string,
    status: TaskStatus,
    beforeId?: string | null,
    prepare?: () => Promise<void>
  ) => Promise<void>
  deleteTask: (id: string) => Promise<boolean>
  setTaskQueueStatus: (id: string, queueStatus: TaskQueueStatus) => Promise<Task | null>
  setTaskLocal: (task: Task) => void
}

const TaskBoardContext = React.createContext<TaskBoardContextValue | null>(null)

function groupByStatus(tasks: Task[]): Record<TaskStatus, Task[]> {
  const grouped: Record<TaskStatus, Task[]> = {
    todo: [],
    in_progress: [],
    review: [],
    done: []
  }
  for (const task of tasks) {
    ;(grouped[task.status] ?? grouped.todo).push(task)
  }
  for (const status of TASK_STATUSES) {
    grouped[status].sort((a, b) => a.sortOrder - b.sortOrder)
  }
  return grouped
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

export function TaskBoardProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [tasks, setTasks] = React.useState<Task[]>([])
  const [loading, setLoading] = React.useState(true)
  const [moves, setMoves] = React.useState<
    { token: number; id: string; status: TaskStatus; beforeId?: string | null }[]
  >([])
  const nextMove = React.useRef(0)
  const currentTasks = React.useRef(tasks)
  const revision = React.useRef(0)
  const changedAt = React.useRef(new Map<string, number>())
  const mutationTail = React.useRef<Promise<unknown>>(Promise.resolve())

  const writeTasks = React.useCallback((next: Task[]): void => {
    const before = new Map(currentTasks.current.map((task) => [task.id, task]))
    const after = new Map(next.map((task) => [task.id, task]))
    const version = ++revision.current
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(id) !== after.get(id)) changedAt.current.set(id, version)
    }
    currentTasks.current = next
    setTasks(next)
  }, [])

  const applyResponse = React.useCallback(
    (incoming: Task[], startedAt: { revision: number; tasks: Task[] }, complete = false): void => {
      const protectedIds = new Set(
        [...changedAt.current]
          .filter(([, version]) => version > startedAt.revision)
          .map(([id]) => id)
      )
      writeTasks(
        reconcileTaskList(currentTasks.current, incoming, protectedIds, complete, startedAt.tasks)
      )
    },
    [writeTasks]
  )

  const mutate = React.useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const request = mutationTail.current.then(operation)
    // The caller handles failure; a failed write must not poison subsequent writes.
    mutationTail.current = request.then(
      () => undefined,
      () => undefined
    )
    return request
  }, [])

  const refreshTasks = React.useCallback(async (): Promise<void> => {
    await mutate(async () => {
      const startedAt = { revision: revision.current, tasks: currentTasks.current }
      const list = await listTasks()
      applyResponse(list, startedAt, true)
    })
  }, [applyResponse, mutate])

  React.useEffect(() => {
    let active = true
    refreshTasks()
      .catch((error) => {
        if (active) toast.error(errorMessage(error, 'Could not load tasks.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [refreshTasks])

  React.useEffect(() => {
    let active = true
    let unsubscribe = (): void => {}
    let refreshTimer: ReturnType<typeof setTimeout> | undefined

    void window.api.tasks
      .onUpdate(() => {
        if (!active) return
        if (refreshTimer !== undefined) clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined
          void refreshTasks().catch((error) => {
            if (active) toast.error(errorMessage(error, 'Could not refresh tasks.'))
          })
        }, 100)
      })
      .then((stopUpdates) => {
        if (!active) {
          stopUpdates()
          return
        }
        unsubscribe = stopUpdates
      })
      .catch((error) => {
        console.error('[tasks] failed to subscribe to task updates:', error)
      })

    return () => {
      active = false
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      unsubscribe()
    }
  }, [refreshTasks])

  const handleCreateTask = React.useCallback(
    async (req: CreateTaskRequest): Promise<Task | null> => {
      try {
        const res = await mutate(async () => {
          const startedAt = { revision: revision.current, tasks: currentTasks.current }
          const result = await createTask(req)
          if (result.ok) applyResponse([result.task], startedAt)
          return result
        })
        if (!res.ok) {
          toast.error(res.message ?? 'Could not create task.')
          return null
        }
        return res.task
      } catch (error) {
        toast.error(errorMessage(error, 'Could not create task.'))
        return null
      }
    },
    [applyResponse, mutate]
  )

  const handleUpdateTask = React.useCallback(
    async (req: UpdateTaskRequest): Promise<Task | null> => {
      try {
        const res = await mutate(async () => {
          const startedAt = { revision: revision.current, tasks: currentTasks.current }
          const result = await updateTask(req)
          if (result.ok) applyResponse([result.task], startedAt)
          return result
        })
        if (!res.ok) {
          toast.error(res.message ?? 'Could not update task.')
          return null
        }
        return res.task
      } catch (error) {
        toast.error(errorMessage(error, 'Could not update task.'))
        return null
      }
    },
    [applyResponse, mutate]
  )

  const handleMoveTask = React.useCallback(
    async (
      id: string,
      status: TaskStatus,
      beforeId?: string | null,
      prepare?: () => Promise<void>
    ): Promise<void> => {
      const token = ++nextMove.current
      setMoves((current) => [...current, { token, id, status, beforeId }])
      try {
        await prepare?.()
        const res = await mutate(async () => {
          const startedAt = { revision: revision.current, tasks: currentTasks.current }
          const result = await moveTask({ id, status, beforeId })
          if (result.ok) applyResponse(result.tasks, startedAt, true)
          return result
        })
        if (!res.ok) {
          toast.error(res.message ?? 'Could not move task.')
        }
      } catch (error) {
        toast.error(errorMessage(error, 'Could not move task.'))
      } finally {
        setMoves((current) => current.filter((move) => move.token !== token))
      }
    },
    [applyResponse, mutate]
  )

  const handleDeleteTask = React.useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await mutate(async () => {
          const result = await deleteTask({ id })
          if (result.ok) {
            changedAt.current.set(id, ++revision.current)
            writeTasks(currentTasks.current.filter((task) => task.id !== id))
          }
          return result
        })
        if (!res.ok) {
          toast.error(res.message ?? 'Could not delete task.')
          return false
        }
        return true
      } catch (error) {
        toast.error(errorMessage(error, 'Could not delete task.'))
        return false
      }
    },
    [mutate, writeTasks]
  )

  const handleSetTaskQueueStatus = React.useCallback(
    async (id: string, queueStatus: TaskQueueStatus): Promise<Task | null> => {
      try {
        const res = await mutate(async () => {
          const startedAt = { revision: revision.current, tasks: currentTasks.current }
          const result = await setTaskQueueStatus({ id, queueStatus })
          if (result.ok) applyResponse([result.task], startedAt)
          return result
        })
        if (!res.ok) {
          toast.error(res.message ?? 'Could not update the task queue.')
          return null
        }
        return res.task
      } catch (error) {
        toast.error(errorMessage(error, 'Could not update the task queue.'))
        return null
      }
    },
    [applyResponse, mutate]
  )

  const setTaskLocal = React.useCallback(
    (task: Task): void => {
      writeTasks(currentTasks.current.map((current) => (current.id === task.id ? task : current)))
    },
    [writeTasks]
  )

  const visibleTasks = React.useMemo(
    () =>
      moves.reduce(
        (current, move) => moveTaskOptimistically(current, move.id, move.status, move.beforeId),
        tasks
      ),
    [tasks, moves]
  )

  const value = React.useMemo<TaskBoardContextValue>(
    () => ({
      tasks: visibleTasks,
      tasksByStatus: groupByStatus(visibleTasks),
      loading,
      createTask: handleCreateTask,
      updateTask: handleUpdateTask,
      moveTask: handleMoveTask,
      deleteTask: handleDeleteTask,
      setTaskQueueStatus: handleSetTaskQueueStatus,
      setTaskLocal
    }),
    [
      visibleTasks,
      loading,
      handleCreateTask,
      handleUpdateTask,
      handleMoveTask,
      handleDeleteTask,
      handleSetTaskQueueStatus,
      setTaskLocal
    ]
  )

  return <TaskBoardContext.Provider value={value}>{children}</TaskBoardContext.Provider>
}

export function useTaskBoard(): TaskBoardContextValue {
  const ctx = React.useContext(TaskBoardContext)
  if (!ctx) {
    throw new Error('useTaskBoard must be used within a TaskBoardProvider')
  }
  return ctx
}
