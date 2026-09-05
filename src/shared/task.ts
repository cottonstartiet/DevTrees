export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done'

export type Task = {
  id: string
  title: string
  description: string
  status: TaskStatus
  repositoryId: string
  repositoryName: string
  repositoryPath: string
  worktreePath: string
  worktreeBranch: string | null
  pendingWorktreeName: string | null
  copilotSessionId: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type CreateTaskRequest = {
  title: string
  description: string
  repositoryId: string
  repositoryName: string
  repositoryPath: string
  worktreePath: string
  worktreeBranch: string | null
  pendingWorktreeName: string | null
}

export type TaskErrorCode = 'invalid-title' | 'not-found' | 'unknown'

export type CreateTaskResult =
  | { ok: true; task: Task }
  | { ok: false; error: TaskErrorCode; message?: string }

export type UpdateTaskRequest = {
  id: string
  title: string
  description: string
  repositoryId: string
  repositoryName: string
  repositoryPath: string
  worktreePath: string
  worktreeBranch: string | null
  pendingWorktreeName: string | null
}

export type UpdateTaskResult =
  | { ok: true; task: Task }
  | { ok: false; error: TaskErrorCode; message?: string }

export type MoveTaskRequest = {
  id: string
  status: TaskStatus
  /** Id of the task this one should be placed immediately before within `status`; null/omitted to append at the end. */
  beforeId?: string | null
}

export type MoveTaskResult =
  | { ok: true; tasks: Task[] }
  | { ok: false; error: TaskErrorCode; message?: string }

export type DeleteTaskRequest = {
  id: string
}

export type DeleteTaskResult = { ok: true } | { ok: false; error: TaskErrorCode; message?: string }

export type SetTaskCopilotSessionRequest = {
  id: string
  copilotSessionId: string
}

export const TaskIpcChannels = {
  List: 'tasks:list',
  Create: 'tasks:create',
  Update: 'tasks:update',
  Move: 'tasks:move',
  Delete: 'tasks:delete',
  setCopilotSession: 'tasks:set-copilot-session'
} as const
