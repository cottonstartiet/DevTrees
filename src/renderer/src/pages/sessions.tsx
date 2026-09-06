import * as React from 'react'
import { TerminalIcon } from 'lucide-react'

import { TerminalSessionView } from '@/components/sessions/terminal-session-view'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'

export function SessionsHeaderControls(): React.JSX.Element {
  const { sessions, connectionState } = useTerminalSessions()
  const connectionLabel = {
    connecting: 'Connecting',
    live: 'Live',
    reconnecting: 'Reconnecting',
    'host-unavailable': 'Host unavailable',
    'restored-from-snapshot': 'Restored'
  }[connectionState]
  return (
    <div className="ml-auto flex items-center gap-3">
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          className={`size-1.5 rounded-full ${
            connectionState === 'live'
              ? 'bg-emerald-500'
              : connectionState === 'host-unavailable'
                ? 'bg-destructive'
                : 'bg-amber-500'
          }`}
        />
        {connectionLabel}
      </span>
      <span className="text-muted-foreground text-xs">
        {sessions.length} session{sessions.length === 1 ? '' : 's'}
      </span>
    </div>
  )
}

/**
 * Sessions are Copilot CLI runs managed by DevTrees over ACP. Pick a session in the
 * sidebar to inspect its history, respond to questions, and continue the conversation.
 */
export function SessionsPage(): React.JSX.Element {
  const { sessions, selectedId } = useTerminalSessions()
  const selected = sessions.find((session) => session.id === selectedId) ?? null

  if (selected) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TerminalSessionView key={selected.id} session={selected} />
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
