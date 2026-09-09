import type { TaskQueueSettings } from '@shared/settings'

export const TASK_QUEUE_SETTINGS_CHANGED_EVENT = 'task-queue-settings-changed'

export async function saveTaskQueueSettings(settings: TaskQueueSettings): Promise<void> {
  await window.api.settings.setTaskQueue(settings)
  window.dispatchEvent(
    new CustomEvent<TaskQueueSettings>(TASK_QUEUE_SETTINGS_CHANGED_EVENT, { detail: settings })
  )
}
