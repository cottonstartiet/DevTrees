export type SessionLaunchMode = 'sdk' | 'external'

export function sessionLaunchModeLabel(mode: SessionLaunchMode): string {
  return mode === 'sdk' ? 'In-app chat' : 'External Copilot terminal'
}
