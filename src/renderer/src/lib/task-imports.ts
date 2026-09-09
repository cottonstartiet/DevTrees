import type { TaskImportResult } from '@shared/task-import'
import type { TaskSourceProvider } from '@shared/task'

export function listTaskImports(
  provider: TaskSourceProvider,
  repositoryPath: string
): Promise<TaskImportResult> {
  return window.api.taskImports[provider](repositoryPath)
}
