import type { TerminalTimelineEntry } from '@shared/terminal-session'

export type RemoteTimelineContext = {
  sessionFinished: boolean
  hasLiveInteraction: boolean
}

export type RemoteTimelinePresentation =
  | { display: 'omit' }
  | { display: 'message'; role: 'user' | 'assistant'; text: string }
  | { display: 'notice'; tone: 'info' | 'error'; summary: string; detail: string }
  | { display: 'waiting'; summary: string; detail: string }
  | {
      display: 'collapsed'
      outcome: 'success' | 'failure' | 'neutral'
      summary: string
      status?: string
    }

const ACTIVE_ACP_TOOL_STATUSES = new Set(['', 'pending', 'in_progress'])
const FAILED_ACP_TOOL_STATUSES = new Set(['failed', 'cancelled', 'incomplete'])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function acpSummary(entry: Extract<TerminalTimelineEntry, { kind: 'acp' }>): string {
  const value = record(entry.data)
  return (
    text(value.title) ??
    (entry.category === 'plan'
      ? 'Plan'
      : entry.category === 'agent_thought_chunk'
        ? 'Reasoning'
        : entry.category === 'tool'
          ? 'Tool activity'
          : 'Copilot activity')
  )
}

export function remoteTimelinePresentation(
  entry: TerminalTimelineEntry,
  context: RemoteTimelineContext
): RemoteTimelinePresentation {
  switch (entry.kind) {
    case 'userMessage':
      return { display: 'message', role: 'user', text: entry.text }
    case 'assistantMessage':
      return { display: 'message', role: 'assistant', text: entry.text }
    case 'notice':
      return {
        display: 'notice',
        tone: entry.level,
        summary: entry.level === 'error' ? 'Error' : 'Notice',
        detail: entry.text
      }
    case 'permission':
      if (entry.resolution == null) {
        return context.hasLiveInteraction
          ? { display: 'omit' }
          : {
              display: 'waiting',
              summary: 'Permission needed',
              detail: entry.description
            }
      }
      return {
        display: 'collapsed',
        outcome: 'neutral',
        summary: 'Permission',
        status: entry.resolution
      }
    case 'toolCall':
      if (entry.success == null) {
        return context.sessionFinished
          ? {
              display: 'collapsed',
              outcome: 'failure',
              summary: entry.name || 'Tool activity',
              status: 'did not complete'
            }
          : { display: 'omit' }
      }
      return {
        display: 'collapsed',
        outcome: entry.success ? 'success' : 'failure',
        summary: entry.name || 'Tool activity',
        status: entry.success ? 'completed' : 'failed'
      }
    case 'acp': {
      if (entry.category !== 'tool') {
        return {
          display: 'collapsed',
          outcome: 'neutral',
          summary: acpSummary(entry)
        }
      }
      const value = record(entry.data)
      const status = text(value.status)?.toLowerCase() ?? ''
      if (ACTIVE_ACP_TOOL_STATUSES.has(status)) {
        return context.sessionFinished
          ? {
              display: 'collapsed',
              outcome: 'failure',
              summary: acpSummary(entry),
              status: 'did not complete'
            }
          : { display: 'omit' }
      }
      return {
        display: 'collapsed',
        outcome:
          status === 'completed'
            ? 'success'
            : FAILED_ACP_TOOL_STATUSES.has(status)
              ? 'failure'
              : 'neutral',
        summary: acpSummary(entry),
        status
      }
    }
  }
}
