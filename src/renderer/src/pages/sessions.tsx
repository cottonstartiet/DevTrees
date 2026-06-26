import * as React from 'react'
import {
  GalleryThumbnails as GalleryThumbnailsIcon,
  LayoutGrid as LayoutGridIcon,
  TerminalSquare as TerminalSquareIcon
} from 'lucide-react'

import { SessionFocus } from '@/components/sessions/session-focus'
import { SessionGrid } from '@/components/sessions/session-grid'
import { useSessions } from '@/contexts/sessions-context'
import { cn } from '@/lib/utils'
import type { SessionViewMode } from '@/pages/sessions-view-mode'

const VIEW_MODES: { mode: SessionViewMode; label: string; Icon: typeof LayoutGridIcon }[] = [
  { mode: 'tabs', label: 'Tabs', Icon: GalleryThumbnailsIcon },
  { mode: 'grid', label: 'Grid', Icon: LayoutGridIcon }
]

/**
 * Session count + view-mode switcher, rendered in the app's top header bar for the Sessions view so
 * the page itself can use the full height for terminals.
 */
export function SessionsHeaderControls({
  viewMode,
  onChange
}: {
  viewMode: SessionViewMode
  onChange: (mode: SessionViewMode) => void
}): React.JSX.Element {
  const { sessions } = useSessions()
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
              'flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs transition-colors',
              viewMode === mode
                ? 'bg-background text-foreground shadow-sm'
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

export function SessionsPage({ viewMode }: { viewMode: SessionViewMode }): React.JSX.Element {
  const { sessions, activeSessionId, cycleSession } = useSessions()

  const activeSession = React.useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  )

  // Cycle the active session with the keyboard while the Sessions view is mounted. Ctrl+Tab /
  // Ctrl+Shift+Tab is the primary binding; Ctrl+PageDown / Ctrl+PageUp is a fallback because some
  // WebView2 builds intercept Ctrl+Tab.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      if (e.key === 'Tab') {
        e.preventDefault()
        cycleSession(e.shiftKey ? -1 : 1)
      } else if (e.key === 'PageDown') {
        e.preventDefault()
        cycleSession(1)
      } else if (e.key === 'PageUp') {
        e.preventDefault()
        cycleSession(-1)
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [cycleSession])

  if (sessions.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <TerminalSquareIcon className="size-10 opacity-40" />
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">No Copilot sessions</p>
          <p className="text-xs">
            Start one with the Copilot action on a worktree, &ldquo;Address with Copilot&rdquo;, or
            &ldquo;Resolve conflicts with Copilot&rdquo;.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        {viewMode === 'grid' ? (
          <SessionGrid sessions={sessions} activeSessionId={activeSessionId} />
        ) : activeSession ? (
          <SessionFocus sessions={sessions} activeSession={activeSession} />
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
            Select a session.
          </div>
        )}
      </div>
    </div>
  )
}
