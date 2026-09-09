export type SessionLaunchMode = 'acp' | 'external'
export type CopilotPermissionProfile = 'default' | 'allow-all'
export type TaskQueueMode = 'automatic' | 'manual'

export type TaskQueueSettings = {
  mode: TaskQueueMode
  concurrency: number
}

export function sessionLaunchModeLabel(mode: SessionLaunchMode): string {
  return mode === 'external' ? 'External Copilot terminal' : 'In-app chat'
}

export function copilotPermissionProfileLabel(profile: CopilotPermissionProfile): string {
  return profile === 'allow-all' ? 'Allow all' : 'Ask when needed'
}
