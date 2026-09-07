import * as React from 'react'
import { TerminalIcon } from 'lucide-react'

import { TerminalSessionView } from '@/components/sessions/terminal-session-view'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'

export function SessionsHeaderControls(): React.JSX.Element {
  const { sessions, launchTransport, setLaunchTransport } = useTerminalSessions()
  return (
    <div className="ml-auto flex items-center gap-3">
      <label className="flex items-center gap-2 text-xs">
        New sessions
        <select
          className="bg-background border-input focus-visible:ring-ring h-8 rounded-md border px-2 text-xs focus-visible:outline-none focus-visible:ring-3"
          value={launchTransport}
          onChange={(event) => setLaunchTransport(event.target.value === 'sdk' ? 'sdk' : 'pty')}
        >
          <option value="sdk">Native UI</option>
          <option value="pty">Terminal</option>
        </select>
      </label>
      <span className="text-muted-foreground text-xs">
        {sessions.length} session{sessions.length === 1 ? '' : 's'}
      </span>
    </div>
  )
}

/**
 * Pick an app-owned Copilot terminal or its optional read-only transcript.
 */
export function SessionsPage(): React.JSX.Element {
  const { sessions, selectedId, selectionRevision } = useTerminalSessions()
  const selected = sessions.find((session) => session.id === selectedId) ?? null

  if (selected) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TerminalSessionView
          key={`${selected.id}:${selected.generation}:${selectionRevision}`}
          session={selected}
        />
      </div>
    )
  }

  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <TerminalIcon className="size-10 opacity-35" />
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">
          {sessions.length === 0 ? 'No Copilot sessions' : 'No session selected'}
        </p>
        <p className="max-w-sm text-xs">
          {sessions.length === 0
            ? 'Start Copilot from a repository, worktree, pull request, or task. The managed session appears here and stays interactive.'
            : 'Pick a session in the sidebar to see its history.'}
        </p>
      </div>
    </div>
  )
}
