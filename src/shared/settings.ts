export type SessionLaunchMode = 'acp' | 'embedded' | 'external'
export type CopilotPermissionProfile = 'default' | 'allow-all'
export type TaskQueueMode = 'automatic' | 'manual'

export type TaskQueueSettings = {
  mode: TaskQueueMode
  concurrency: number
}

export type SavedPrompt = {
  id: string
  name: string
  details: string
  createdAt: number
  updatedAt: number
}

export type CreateSavedPromptRequest = {
  name: string
  details: string
}

export type UpdateSavedPromptRequest = CreateSavedPromptRequest & {
  id: string
}

export function sessionLaunchModeLabel(mode: SessionLaunchMode): string {
  if (mode === 'external') return 'External Copilot terminal'
  if (mode === 'embedded') return 'Embedded terminal'
  return 'In-app chat'
}

export function copilotPermissionProfileLabel(profile: CopilotPermissionProfile): string {
  return profile === 'allow-all' ? 'Allow all' : 'Ask when needed'
}
