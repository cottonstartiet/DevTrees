import type { Task } from '@shared/task'
import type { TerminalSession } from '@shared/terminal-session'

export type SessionCardPresentation = {
  title: string
  detail: string | null
}

export function sessionCardPresentation(
  session: TerminalSession,
  tasks: readonly Task[]
): SessionCardPresentation {
  const taskTitle = session.taskId
    ? tasks.find((task) => task.id === session.taskId)?.title.trim()
    : undefined
  const detail =
    session.status === 'waiting-input'
      ? (session.pendingPrompt?.trim() || session.lastActivity.trim() || null)
      : null

  return {
    title: taskTitle || session.label,
    detail
  }
}
