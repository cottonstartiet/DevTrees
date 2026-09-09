export type SessionLaunchMode = 'acp' | 'external'
export type TaskQueueMode = 'automatic' | 'manual'

export type TaskQueueSettings = {
  mode: TaskQueueMode
  concurrency: number
}

export function sessionLaunchModeLabel(mode: SessionLaunchMode): string {
  return mode === 'external' ? 'External Copilot terminal' : 'In-app chat'
}
