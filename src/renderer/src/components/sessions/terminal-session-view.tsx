import * as React from 'react'
import { ExternalLinkIcon, FolderGitIcon, GitBranchIcon, Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'

import {
  TERMINAL_SESSION_STATUS_LABEL,
  TERMINAL_SESSION_STATUS_TONE
} from '@/components/sessions/terminal-session-status'
import { TerminalTimeline } from '@/components/sessions/terminal-timeline'
import { SessionInteraction } from '@/components/sessions/session-interaction'
import { Button } from '@/components/ui/button'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { cn } from '@/lib/utils'
import {
  isTerminalSessionFinished,
  type TerminalSession,
  type TerminalSessionStatus
} from '@shared/terminal-session'

const STATUS_LABEL = TERMINAL_SESSION_STATUS_LABEL
const STATUS_TONE = TERMINAL_SESSION_STATUS_TONE

export function TerminalSessionStatusBadge({
  status,
  className
}: {
  status: TerminalSessionStatus
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        STATUS_TONE[status],
        className
      )}
    >
      {status === 'working' && <Loader2Icon className="size-3 animate-spin" />}
      {STATUS_LABEL[status]}
    </span>
  )
}

/**
 * Detail view for a Copilot ACP session. When a session has ended, it can be resumed with
 * the same session id so its history continues.
 */
export function TerminalSessionView({ session }: { session: TerminalSession }): React.JSX.Element {
  const { entriesById, interactionById, loadHistory } = useTerminalSessions()
  const launch = useCopilotLauncher()
  const [resuming, setResuming] = React.useState(false)

  React.useEffect(() => {
    void loadHistory(session.id)
  }, [session.id, loadHistory])

  const entries = entriesById[session.id] ?? []
  const interaction = interactionById[session.id]
  const finished = isTerminalSessionFinished(session.status)

  const handleResume = async (): Promise<void> => {
    setResuming(true)
    try {
      const result = await launch({
        folderPath: session.folderPath,
        resumeSessionId: session.id,
        label: session.label,
        repository: session.repository ?? undefined,
        branch: session.branch ?? undefined,
        taskId: session.taskId ?? undefined
      })
      if (result.ok) toast.success(`Resumed ${session.label} in a new terminal.`)
      else toast.error(result.error)
    } finally {
      setResuming(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{session.label}</h2>
            <TerminalSessionStatusBadge status={session.status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {session.repository && (
              <span className="flex items-center gap-1">
                <FolderGitIcon className="size-3" />
                {session.repository}
              </span>
            )}
            {session.branch && (
              <span className="flex items-center gap-1">
                <GitBranchIcon className="size-3" />
                {session.branch}
              </span>
            )}
            <span className="truncate font-mono">{session.folderPath}</span>
          </div>
        </div>
        {finished && (
          <Button size="sm" onClick={() => void handleResume()} disabled={resuming}>
            {resuming ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <ExternalLinkIcon className="size-3.5" />
            )}
            Resume
          </Button>
        )}
      </header>

      {session.status === 'waiting-input' && !interaction && (
        <div className="border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
          Copilot is waiting for your response.
          {session.pendingPrompt ? ` ${session.pendingPrompt}` : ''}
        </div>
      )}

      <TerminalTimeline entries={entries} />
      {interaction ? (
        <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 border-t px-4 py-3">
          <span aria-hidden="true" />
          <SessionInteraction
            key={interaction.requestId}
            session={session}
            interaction={interaction}
          />
        </div>
      ) : (
        <SessionInteraction key="composer" session={session} />
      )}
    </div>
  )
}
