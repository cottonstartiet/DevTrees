import * as React from 'react'
import { TerminalIcon } from 'lucide-react'

import { TerminalSessionView } from '@/components/sessions/terminal-session-view'
import { EmbeddedTerminalView } from '@/components/sessions/embedded-terminal-view'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'

export function SessionsHeaderControls(): React.JSX.Element {
  const { sessions, embeddedTerminals } = useTerminalSessions()
  const count = sessions.length + embeddedTerminals.length
  return (
    <div className="ml-auto flex items-center gap-3">
      <span className="text-muted-foreground text-xs">
        {count} session{count === 1 ? '' : 's'}
      </span>
    </div>
  )
}

/**
 * Inspect native chat or the current external session's status.
 */
export function SessionsPage(): React.JSX.Element {
  const { sessions, embeddedTerminals, selectedId, selectionRevision } = useTerminalSessions()
  const selected = sessions.find((session) => session.id === selectedId) ?? null
  const selectedTerminal =
    embeddedTerminals.find((terminal) => terminal.terminalId === selectedId) ?? null

  if (selectedTerminal) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <EmbeddedTerminalView
          key={`${selectedTerminal.terminalId}:${selectionRevision}`}
          terminal={selectedTerminal}
        />
      </div>
    )
  }

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
          {sessions.length + embeddedTerminals.length === 0
            ? 'No active sessions'
            : 'No session selected'}
        </p>
        <p className="max-w-sm text-xs">
          {sessions.length + embeddedTerminals.length === 0
            ? 'Start Copilot from a repository, worktree, pull request, or task, or use the plus button to open PowerShell.'
            : 'Pick a session in the sidebar to see its history.'}
        </p>
      </div>
    </div>
  )
}
