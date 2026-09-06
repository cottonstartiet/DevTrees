import * as React from 'react'
import { ExternalLinkIcon, FolderGitIcon, GitBranchIcon, Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'

import {
  TERMINAL_SESSION_STATUS_LABEL,
  TERMINAL_SESSION_STATUS_TONE
} from '@/components/sessions/terminal-session-status'
import { TerminalTimeline } from '@/components/sessions/terminal-timeline'
import { PtyTerminalView } from '@/components/sessions/pty-terminal-view'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { cn } from '@/lib/utils'
import {
  isTerminalSessionFinished,
  terminalObservationIssue,
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
 * Detail view for an embedded Copilot terminal. When a session has ended, it can be resumed with
 * the same session id so its history continues.
 */
export function TerminalSessionView({ session }: { session: TerminalSession }): React.JSX.Element {
  const { entriesById, loadHistory, observationNow } = useTerminalSessions()
  const launch = useCopilotLauncher()
  const [resuming, setResuming] = React.useState(false)

  React.useEffect(() => {
    void loadHistory(session.id)
  }, [session.id, loadHistory])

  const entries = entriesById[session.id] ?? []
  const finished = isTerminalSessionFinished(session.status)
  const observationIssue = terminalObservationIssue(session, observationNow)

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
      if (result.ok) toast.success(`Resumed ${session.label} in the embedded terminal.`)
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

      {observationIssue && !finished && (
        <p className="bg-muted border-b px-4 py-2 text-xs" role="status">
          {observationIssue} The terminal remains available.
        </p>
      )}
      <Tabs
        defaultValue="terminal"
        className="min-h-0 flex-1 gap-0"
        onValueChange={(value) => {
          if (value === 'transcript') void loadHistory(session.id)
        }}
      >
        <div className="border-b px-4 py-2">
          <TabsList aria-label="Session view">
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          value="terminal"
          className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <PtyTerminalView session={session} />
        </TabsContent>
        <TabsContent
          value="transcript"
          className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <p className="text-muted-foreground border-b px-4 py-2 text-xs">
            Read-only history. It may lag behind the terminal; respond in the Terminal view.
          </p>
          <TerminalTimeline entries={entries} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
