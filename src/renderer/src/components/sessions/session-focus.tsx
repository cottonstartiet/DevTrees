import * as React from 'react'

import { SessionTile } from '@/components/sessions/session-tile'
import { TerminalView } from '@/components/sessions/terminal-view'
import type { CopilotSession } from '@shared/sessions'

/**
 * One large live terminal for the active session plus a filmstrip of lightweight tiles for the
 * rest. Only the focused session mounts an xterm; the tiles are cheap previews, so this scales to
 * many sessions. Clicking a tile makes it the active/focused session.
 */
export function SessionFocus({
  sessions,
  activeSession
}: {
  sessions: CopilotSession[]
  activeSession: CopilotSession
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {sessions.length > 1 ? (
        <div className="bg-muted/20 flex shrink-0 items-stretch gap-2 overflow-x-auto border-b p-2">
          {sessions.map((session) => (
            <SessionTile
              key={session.id}
              session={session}
              isActive={session.id === activeSession.id}
            />
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <TerminalView key={activeSession.id} session={activeSession} />
      </div>
    </div>
  )
}
