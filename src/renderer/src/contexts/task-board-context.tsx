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
  moveTask: (id: string, status: TaskStatus, beforeId?: string | null) => Promise<void>
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
  const moveSeqRef = React.useRef(0)

  React.useEffect(() => {
    let active = true
    listTasks()
      .then((list) => {
        if (!active) return
        // Merge rather than replace: a task created/updated locally while this initial
        // fetch was in flight would otherwise be wiped out by the (now-stale) response.
        setTasks((prev) => {
          const byId = new Map(list.map((t) => [t.id, t]))
          for (const t of prev) {
            if (!byId.has(t.id)) byId.set(t.id, t)
          }
          return Array.from(byId.values())
        })
      })
      .catch((error) => {
        if (active) toast.error(errorMessage(error, 'Could not load tasks.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const handleCreateTask = React.useCallback(
    async (req: CreateTaskRequest): Promise<Task | null> => {
      try {
        const res = await createTask(req)
        if (!res.ok) {
          toast.error(res.message ?? 'Could not create task.')
          return null
        }
        setTasks((prev) => [...prev, res.task])
        return res.task
      } catch (error) {
        toast.error(errorMessage(error, 'Could not create task.'))
        return null
      }
    },
    []
  )

  const handleUpdateTask = React.useCallback(
    async (req: UpdateTaskRequest): Promise<Task | null> => {
      try {
        const res = await updateTask(req)
        if (!res.ok) {
          toast.error(res.message ?? 'Could not update task.')
          return null
        }
        setTasks((prev) => prev.map((t) => (t.id === res.task.id ? res.task : t)))
        return res.task
      } catch (error) {
        toast.error(errorMessage(error, 'Could not update task.'))
        return null
      }
    },
    []
  )

  const handleMoveTask = React.useCallback(
    async (id: string, status: TaskStatus, beforeId?: string | null): Promise<void> => {
      const seq = ++moveSeqRef.current
      const previous = tasks
      // Optimistic update so drag-and-drop feels immediate; rolled back on failure.
      setTasks((prev) => {
        const target = prev.find((t) => t.id === id)
        if (!target) return prev
        const rest = prev.filter((t) => t.id !== id)
        const destIds = rest.filter((t) => t.status === status)
        const insertIndex = beforeId != null ? destIds.findIndex((t) => t.id === beforeId) : -1
        const moved: Task = { ...target, status }
        if (insertIndex < 0) {
          return [...rest, moved]
        }
        const before = destIds[insertIndex]
        const idx = rest.findIndex((t) => t.id === before.id)
        return [...rest.slice(0, idx), moved, ...rest.slice(idx)]
      })
      try {
        const res = await moveTask({ id, status, beforeId })
        // Ignore stale responses: if a newer move has started since this one was issued,
        // applying this result (success or failure) would clobber the newer optimistic
        // state or a more recent server response.
        if (seq !== moveSeqRef.current) return
        if (!res.ok) {
          toast.error(res.message ?? 'Could not move task.')
          setTasks(previous)
          return
        }
        setTasks(res.tasks)
      } catch (error) {
        if (seq !== moveSeqRef.current) return
        toast.error(errorMessage(error, 'Could not move task.'))
        setTasks(previous)
      }
    },
    [tasks]
  )

  const handleDeleteTask = React.useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await deleteTask({ id })
      if (!res.ok) {
        toast.error(res.message ?? 'Could not delete task.')
        return false
      }
      setTasks((prev) => prev.filter((t) => t.id !== id))
      return true
    } catch (error) {
      toast.error(errorMessage(error, 'Could not delete task.'))
      return false
    }
  }, [])

  const handleSetTaskQueueStatus = React.useCallback(
    async (id: string, queueStatus: TaskQueueStatus): Promise<Task | null> => {
      try {
        const res = await setTaskQueueStatus({ id, queueStatus })
        if (!res.ok) {
          toast.error(res.message ?? 'Could not update the task queue.')
          return null
        }
        setTasks((prev) => prev.map((task) => (task.id === res.task.id ? res.task : task)))
        return res.task
      } catch (error) {
        toast.error(errorMessage(error, 'Could not update the task queue.'))
        return null
      }
    },
    []
  )

  const setTaskLocal = React.useCallback((task: Task): void => {
    setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)))
  }, [])

  const value = React.useMemo<TaskBoardContextValue>(
    () => ({
      tasks,
      tasksByStatus: groupByStatus(tasks),
      loading,
      createTask: handleCreateTask,
      updateTask: handleUpdateTask,
      moveTask: handleMoveTask,
      deleteTask: handleDeleteTask,
      setTaskQueueStatus: handleSetTaskQueueStatus,
      setTaskLocal
    }),
    [
      tasks,
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
