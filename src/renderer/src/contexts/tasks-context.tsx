/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'

export type TaskStatus = 'running' | 'success' | 'error'

export type Task = {
  id: string
  label: string
  status: TaskStatus
  startedAt: number
  endedAt?: number
  errorMessage?: string
}

export interface TasksContextValue {
  tasks: Task[]
  runningTasks: Task[]
  latestTask: Task | null
  startTask: (label: string) => string
  succeedTask: (id: string) => void
  failTask: (id: string, message?: string) => void
}

const MAX_TASKS = 10

const TasksContext = React.createContext<TasksContextValue | null>(null)

function genId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID()
  }
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

interface TasksProviderProps {
  children: React.ReactNode
}

export function TasksProvider({ children }: TasksProviderProps): React.JSX.Element {
  const [tasks, setTasks] = React.useState<Task[]>([])

  const startTask = React.useCallback((label: string): string => {
    const task: Task = {
      id: genId(),
      label,
      status: 'running',
      startedAt: Date.now()
    }
    setTasks((prev) => [task, ...prev].slice(0, MAX_TASKS))
    return task.id
  }, [])

  const succeedTask = React.useCallback((id: string): void => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status: 'success', endedAt: Date.now() } : t))
    )
  }, [])

  const failTask = React.useCallback((id: string, message?: string): void => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, status: 'error', endedAt: Date.now(), errorMessage: message } : t
      )
    )
  }, [])

  const value = React.useMemo<TasksContextValue>(() => {
    const runningTasks = tasks.filter((t) => t.status === 'running')
    const latestTask = runningTasks[0] ?? tasks[0] ?? null
    return {
      tasks,
      runningTasks,
      latestTask,
      startTask,
      succeedTask,
      failTask
    }
  }, [tasks, startTask, succeedTask, failTask])

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
}

export function useTasks(): TasksContextValue {
  const ctx = React.useContext(TasksContext)
  if (!ctx) {
    throw new Error('useTasks must be used within a TasksProvider')
  }
  return ctx
}
