export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done'
export type TaskQueueStatus = 'queued' | 'running' | 'complete' | 'failed'

export function taskLaunchInitialMode(status: TaskStatus): 'plan' | 'autopilot' | undefined {
  if (status === 'todo') return 'plan'
  if (status === 'review') return 'autopilot'
  return undefined
}

type QueueTarget = {
  executionTargetKey: string
}

export function selectTaskQueueCandidates<T extends QueueTarget>(
  queuedTasks: readonly T[],
  runningTasks: readonly QueueTarget[],
  dispatchingTargets: Iterable<string>,
  available: number
): T[] {
  if (available <= 0) return []
  const occupiedTargets = new Set(runningTasks.map((task) => task.executionTargetKey))
  for (const target of dispatchingTargets) occupiedTargets.add(target)
  const selected: T[] = []
  for (const task of queuedTasks) {
    if (occupiedTargets.has(task.executionTargetKey)) continue
    occupiedTargets.add(task.executionTargetKey)
    selected.push(task)
    if (selected.length === available) break
  }
  return selected
}

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
  queueStatus: TaskQueueStatus
  queueOrder: number
  sortOrder: number
  executionTargetKey: string
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

export type TaskErrorCode = 'invalid-title' | 'not-found' | 'target-busy' | 'unknown'

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

export type SetTaskQueueStatusRequest = {
  id: string
  queueStatus: TaskQueueStatus
}

export type ClaimTaskRunRequest = {
  id: string
}

export const TaskIpcChannels = {
  List: 'tasks:list',
  Create: 'tasks:create',
  Update: 'tasks:update',
  Move: 'tasks:move',
  Delete: 'tasks:delete',
  setCopilotSession: 'tasks:set-copilot-session',
  setQueueStatus: 'tasks:set-queue-status',
  claimRun: 'tasks:claim-run'
} as const
