import * as React from 'react'
import {
  GalleryThumbnails as GalleryThumbnailsIcon,
  LayoutGrid as LayoutGridIcon,
  SparklesIcon
} from 'lucide-react'

import { AgentSessionView } from '@/components/agent-sessions/session-view'
import { useAgentSessions } from '@/contexts/agent-sessions-context'
import { cn } from '@/lib/utils'
import type { SessionViewMode } from '@/pages/sessions-view-mode'
import type { AgentSession } from '@shared/agent-session'

const VIEW_MODES: { mode: SessionViewMode; label: string; Icon: typeof LayoutGridIcon }[] = [
  { mode: 'tabs', label: 'Tabs', Icon: GalleryThumbnailsIcon },
  { mode: 'grid', label: 'Grid', Icon: LayoutGridIcon }
]

export function SessionsHeaderControls({
  viewMode,
  onChange
}: {
  viewMode: SessionViewMode
  onChange: (mode: SessionViewMode) => void
}): React.JSX.Element {
  const { sessions } = useAgentSessions()
  return (
    <div className="ml-auto flex items-center gap-3">
      <span className="text-muted-foreground text-xs">
        {sessions.length} session{sessions.length === 1 ? '' : 's'}
      </span>
      <div className="flex items-center gap-px rounded-md border p-0.5">
        {VIEW_MODES.map(({ mode, label, Icon }) => (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            title={`${label} view`}
            aria-pressed={viewMode === mode}
            className={cn(
              'focus-visible:ring-ring/50 flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-3',
              viewMode === mode
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="size-3.5" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function stateLabel(session: AgentSession): string {
  switch (session.lifecycle) {
    case 'initializing':
      return 'Starting'
    case 'active':
      return session.currentIntent || 'Working'
    case 'waiting_for_permission':
      return 'Permission required'
    case 'waiting_for_user':
      return 'Needs input'
    case 'failed':
      return session.lastError || 'Failed'
    case 'stopped':
      return 'Stopped'
    default:
      return 'Ready'
  }
}

function SessionGrid(): React.JSX.Element {
  const { sessions, activeSessionId, selectSession } = useAgentSessions()
  return (
    <div className="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 overflow-y-auto p-4">
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          onClick={() => selectSession(session.id)}
          className={cn(
            'bg-card hover:bg-accent/40 focus-visible:ring-ring/50 flex min-h-32 flex-col rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-3',
            activeSessionId === session.id && 'border-primary ring-primary/30 ring-1'
          )}
        >
          <div className="flex w-full items-center gap-2">
            <SparklesIcon className="text-muted-foreground size-3.5" />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">{session.label}</span>
            <span className="text-muted-foreground text-[10px]">
              {session.purpose === 'pr_review' ? 'Review' : 'Agent'}
            </span>
          </div>
          <p className="text-muted-foreground mt-3 line-clamp-3 text-xs">{stateLabel(session)}</p>
          <p className="text-muted-foreground mt-auto w-full truncate pt-3 font-mono text-[10px]">
            {session.repository || session.folderPath}
          </p>
        </button>
      ))}
    </div>
  )
}

export function SessionsPage({ viewMode }: { viewMode: SessionViewMode }): React.JSX.Element {
  const { sessions, activeSessionId, selectSession, cycleSession, close } = useAgentSessions()
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null

  React.useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      if (event.key === 'Tab') {
        event.preventDefault()
        cycleSession(event.shiftKey ? -1 : 1)
      } else if (event.key === 'PageDown') {
        event.preventDefault()
        cycleSession(1)
      } else if (event.key === 'PageUp') {
        event.preventDefault()
        cycleSession(-1)
      } else if ((event.key === 'w' || event.key === 'W') && activeSessionId) {
        event.preventDefault()
        void close(activeSessionId)
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [activeSessionId, close, cycleSession])

  if (sessions.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <SparklesIcon className="size-10 opacity-35" />
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">No Copilot sessions</p>
          <p className="max-w-sm text-xs">
            Start an SDK-backed session from a repository, worktree, pull request, or history entry.
          </p>
        </div>
      </div>
    )
  }

  if (viewMode === 'grid') return <SessionGrid />
  if (!activeSession) return <div className="flex-1" />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="bg-muted/15 flex shrink-0 gap-1 overflow-x-auto border-b p-1.5">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => selectSession(session.id)}
            className={cn(
              'focus-visible:ring-ring/50 min-w-32 max-w-56 truncate rounded-md px-2.5 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-3',
              session.id === activeSession.id
                ? 'bg-background border shadow-xs'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'
            )}
          >
            {session.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <AgentSessionView key={activeSession.id} session={activeSession} />
      </div>
    </div>
  )
}
