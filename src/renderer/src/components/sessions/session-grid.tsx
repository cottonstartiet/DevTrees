import * as React from 'react'
import { CircleDot as CircleDotIcon, X as XIcon } from 'lucide-react'

import { TerminalView } from '@/components/sessions/terminal-view'
import { useSessions } from '@/contexts/sessions-context'
import type { CopilotSession } from '@shared/sessions'
import { cn } from '@/lib/utils'

/**
 * Tiles every session's terminal into a balanced grid, all mounted at once. Columns grow with the
 * session count: 1→1×1, 2→1×2, 3-4→2×2, 5-9→3×3, etc. Each terminal keeps its own PTY size via the
 * TerminalView's fit/ResizeObserver, and the main-process buffer replays on mount so no output is
 * lost when entering this view.
 */
export function SessionGrid({
  sessions,
  activeSessionId
}: {
  sessions: CopilotSession[]
  activeSessionId: string | null
}): React.JSX.Element {
  const { selectSession, killSession } = useSessions()

  const cols = Math.max(1, Math.ceil(Math.sqrt(sessions.length)))
  const rows = Math.max(1, Math.ceil(sessions.length / cols))

  return (
    <div
      className="grid h-full min-h-0 w-full gap-px p-px"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
      }}
    >
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId
        const isRunning = session.status === 'running'
        return (
          <div
            key={session.id}
            className={cn(
              'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-[#1e1e1e]',
              isActive ? 'ring-primary ring-2 ring-inset' : ''
            )}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => selectSession(session.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') selectSession(session.id)
              }}
              className="bg-muted/40 flex shrink-0 items-center gap-1.5 border-b px-2 py-1 text-xs"
              title={`${session.label}\n${session.folderPath}`}
            >
              <CircleDotIcon
                className={cn(
                  'size-3 shrink-0',
                  isRunning ? 'text-emerald-500' : 'text-muted-foreground/50'
                )}
              />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {session.label}
              </span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  killSession(session.id)
                }}
                title={isRunning ? 'Stop and close session' : 'Close session'}
                className="hover:bg-accent hover:text-accent-foreground rounded-sm p-0.5 opacity-60 transition-opacity hover:opacity-100"
              >
                <XIcon className="size-3.5" />
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <TerminalView session={session} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
