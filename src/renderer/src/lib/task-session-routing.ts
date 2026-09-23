import type { TerminalSession } from '@shared/terminal-session'

export function sessionNavigationId(session: TerminalSession): string {
  return session.transport === 'embedded' && session.terminalId
    ? session.terminalId
    : session.id
}

export function openTaskSession(
  session: TerminalSession,
  actions: {
    select: (id: string) => void
    navigate: () => void
    focusExternal: (id: string) => Promise<void>
  }
): void {
  if (session.transport === 'external') {
    void actions.focusExternal(session.id)
    return
  }
  actions.select(sessionNavigationId(session))
  actions.navigate()
}
