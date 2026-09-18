import type { TerminalSessionStatus } from './terminal-session'

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done'
export type TaskQueueStatus = 'queued' | 'running' | 'complete' | 'failed'
export type TaskIntent = 'task' | 'browser-code-review'

export const TASKS_CHANGED_EVENT = 'tasks:changed'

export type TaskAttachment = {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
}

export type TaskAttachmentSelection = TaskAttachment & {
  staged: boolean
}

export function taskLaunchInitialMode(status: TaskStatus): 'plan' | 'autopilot' | undefined {
  if (status === 'todo') return 'plan'
  if (status === 'review') return 'autopilot'
  return undefined
}

export function taskTargetIsOwned(
  queueStatus: TaskQueueStatus,
  sessionStatus?: TerminalSessionStatus
): boolean {
  return (
    queueStatus === 'running' ||
    (sessionStatus !== undefined && sessionStatus !== 'done' && sessionStatus !== 'error')
  )
}

export function taskConsumesQueueCapacity(
  queueStatus: TaskQueueStatus,
  sessionStatus?: TerminalSessionStatus
): boolean {
  if (sessionStatus === 'idle' || sessionStatus === 'done' || sessionStatus === 'error')
    return false
  return sessionStatus !== undefined || queueStatus === 'running'
}

type QueueTarget = {
  executionTargetKey: string
}

export type TaskQueueTargetGroup<T extends QueueTarget> = {
  executionTargetKey: string
  tasks: T[]
}

export function groupTaskQueueByTarget<T extends QueueTarget>(
  queuedTasks: readonly T[]
): TaskQueueTargetGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const task of queuedTasks) {
    const group = groups.get(task.executionTargetKey)
    if (group) group.push(task)
    else groups.set(task.executionTargetKey, [task])
  }
  return Array.from(groups, ([executionTargetKey, tasks]) => ({ executionTargetKey, tasks }))
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
  for (const group of groupTaskQueueByTarget(queuedTasks)) {
    if (occupiedTargets.has(group.executionTargetKey)) continue
    const task = group.tasks[0]
    if (!task) continue
    occupiedTargets.add(group.executionTargetKey)
    selected.push(task)
    if (selected.length === available) break
  }
  return selected
}

export type Task = {
  id: string
  title: string
  description: string
  intent: TaskIntent
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
  attachments: TaskAttachment[]
  createdAt: number
  updatedAt: number
}

export type CreateTaskRequest = {
  title: string
  description: string
  intent?: TaskIntent
  repositoryId: string
  repositoryName: string
  repositoryPath: string
  worktreePath: string
  worktreeBranch: string | null
  pendingWorktreeName: string | null
  attachmentStageId: string
  attachments: TaskAttachmentSelection[]
}

export type TaskErrorCode =
  | 'invalid-title'
  | 'invalid-intent'
  | 'invalid-attachment'
  | 'not-found'
  | 'target-busy'
  | 'unknown'

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
  attachmentStageId: string
  attachments: TaskAttachmentSelection[]
}

export type PickTaskAttachmentsRequest = {
  stageId: string
}

export type PickTaskAttachmentsResult =
  | { ok: true; attachments: TaskAttachment[] }
  | { ok: false; error: TaskErrorCode; message?: string }

export type DiscardTaskAttachmentStageRequest = {
  stageId: string
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
  claimId: string
}

export type SetTaskQueueStatusRequest = {
  id: string
  queueStatus: TaskQueueStatus
}

export type ClaimTaskRunRequest = {
  id: string
}

export type ClaimTaskRunResult =
  | { ok: true; task: Task; claimId: string }
  | { ok: false; error: TaskErrorCode; message?: string }

export type ReleaseTaskRunRequest = {
  id: string
  claimId: string
  queueStatus: 'complete' | 'failed'
}

export const TaskIpcChannels = {
  List: 'tasks:list',
  Create: 'tasks:create',
  Update: 'tasks:update',
  Move: 'tasks:move',
  Delete: 'tasks:delete',
  setCopilotSession: 'tasks:set-copilot-session',
  setQueueStatus: 'tasks:set-queue-status',
  claimRun: 'tasks:claim-run',
  releaseRun: 'tasks:release-run'
} as const
