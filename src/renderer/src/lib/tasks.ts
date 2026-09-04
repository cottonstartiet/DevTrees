import type {
  CreateTaskRequest,
  CreateTaskResult,
  DeleteTaskRequest,
  DeleteTaskResult,
  MoveTaskRequest,
  MoveTaskResult,
  SetTaskCopilotSessionRequest,
  Task,
  UpdateTaskRequest,
  UpdateTaskResult
} from '@shared/task'

export function listTasks(): Promise<Task[]> {
  return window.api.tasks.list()
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
