import type {
  CreateTaskRequest,
  CreateTaskResult,
  ClaimTaskRunRequest,
  DeleteTaskRequest,
  DeleteTaskResult,
  DiscardTaskAttachmentStageRequest,
  ClaimTaskRunResult,
  MoveTaskRequest,
  MoveTaskResult,
  PickTaskAttachmentsRequest,
  PickTaskAttachmentsResult,
  SetTaskCopilotSessionRequest,
  SetTaskQueueStatusRequest,
  ReleaseTaskRunRequest,
  Task,
  UpdateTaskRequest,
  UpdateTaskResult
} from '@shared/task'

export function listTasks(): Promise<Task[]> {
  return window.api.tasks.list()
}

export function pickTaskAttachments(
  req: PickTaskAttachmentsRequest
): Promise<PickTaskAttachmentsResult> {
  return window.api.tasks.pickAttachments(req)
}

export function discardTaskAttachmentStage(req: DiscardTaskAttachmentStageRequest): Promise<void> {
  return window.api.tasks.discardAttachmentStage(req)
}

export function createTask(req: CreateTaskRequest): Promise<CreateTaskResult> {
  return window.api.tasks.create(req)
}

export function updateTask(req: UpdateTaskRequest): Promise<UpdateTaskResult> {
  return window.api.tasks.update(req)
}

export function moveTask(req: MoveTaskRequest): Promise<MoveTaskResult> {
  return window.api.tasks.move(req)
}

export function deleteTask(req: DeleteTaskRequest): Promise<DeleteTaskResult> {
  return window.api.tasks.delete(req)
}

export function setTaskCopilotSession(
  req: SetTaskCopilotSessionRequest
): Promise<UpdateTaskResult> {
  return window.api.tasks.setCopilotSession(req)
}

export function setTaskQueueStatus(req: SetTaskQueueStatusRequest): Promise<UpdateTaskResult> {
  return window.api.tasks.setQueueStatus(req)
}

export function claimTaskRun(req: ClaimTaskRunRequest): Promise<ClaimTaskRunResult> {
  return window.api.tasks.claimRun(req)
}

export function releaseTaskRun(req: ReleaseTaskRunRequest): Promise<UpdateTaskResult> {
  return window.api.tasks.releaseRun(req)
}
