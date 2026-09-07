import * as React from 'react'
import { ExternalLinkIcon, FolderGitIcon, GitBranchIcon, Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'

import {
  TERMINAL_SESSION_STATUS_LABEL,
  TERMINAL_SESSION_STATUS_TONE
} from '@/components/sessions/terminal-session-status'
import { TerminalTimeline } from '@/components/sessions/terminal-timeline'
import { PtyTerminalView } from '@/components/sessions/pty-terminal-view'
import { NativeSessionControls } from '@/components/sessions/session-interaction'
import { endedNativeHistory, nativeKey } from '@shared/native-session'
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
  const {
    entriesById,
    loadHistory,
    observationNow,
    nativeById,
    nativeBusy,
    stopNative,
    endNative,
    selectedInteractionId,
    select
  } = useTerminalSessions()
  const launch = useCopilotLauncher()
  const [resuming, setResuming] = React.useState(false)
  const [switchTo, setSwitchTo] = React.useState<'sdk' | 'pty' | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const native = session.transport === 'sdk'
  const snapshot = nativeById[session.id]
  const currentSnapshot = snapshot?.session.generation === session.generation ? snapshot : undefined
  const focusedRequest = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (!native || isTerminalSessionFinished(session.status)) void loadHistory(session.id)
  }, [session.id, session.status, native, loadHistory])

  React.useEffect(() => {
    if (
      !selectedInteractionId ||
      focusedRequest.current === selectedInteractionId ||
      !currentSnapshot?.interactions.some((request) => request.id === selectedInteractionId)
    )
      return
    const element = document.getElementById(`native-request-${selectedInteractionId}`)
    element?.scrollIntoView({ block: 'nearest' })
    element?.focus({ preventScroll: true })
    if (element) focusedRequest.current = selectedInteractionId
  }, [selectedInteractionId, currentSnapshot?.interactions])

  const finished = isTerminalSessionFinished(session.status)
  const history = entriesById[session.id] ?? []
  const entries =
    native && currentSnapshot
      ? currentSnapshot.entries
      : native && finished
        ? endedNativeHistory(history)
        : history
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
        taskId: session.taskId ?? undefined,
        transport: native ? 'sdk' : 'pty'
      })
      if (result.ok)
        toast.success(`Resuming ${session.label} in ${native ? 'Native UI' : 'Terminal'}.`)
      else toast.error(result.error)
    } finally {
      setResuming(false)
    }
  }

  const handleSwitch = async (transport: 'sdk' | 'pty'): Promise<void> => {
    setResuming(true)
    setActionError(null)
    try {
      if (!session.generation) {
        const result = await launch({
          folderPath: session.folderPath,
          resumeSessionId: session.id,
          label: session.label,
          taskId: session.taskId ?? undefined,
          repository: session.repository ?? undefined,
          branch: session.branch ?? undefined,
          transport
        })
        if (!result.ok) throw new Error(result.error)
      } else {
        const result = await window.api.terminalSessions.switch(
          { id: session.id, generation: session.generation },
          transport
        )
        if (!result.ok) throw new Error(result.error)
        select(result.session.id)
      }
      setSwitchTo(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
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
            <span className="text-muted-foreground text-xs">
              {native ? 'Native UI' : session.transport === 'pty' ? 'Terminal' : 'External'}
            </span>
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
        {native && !finished && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={session.status === 'idle' || nativeBusy[nativeKey(session, 'lifecycle')]}
              onClick={() => void stopNative(session)}
            >
              Stop turn
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={nativeBusy[nativeKey(session, 'lifecycle')]}
              onClick={() => void endNative(session)}
            >
              End session
            </Button>
          </div>
        )}
        {(native || session.transport === 'pty' || finished) && (
          <Button
            size="sm"
            variant="outline"
            disabled={resuming || nativeBusy[nativeKey(session, 'lifecycle')]}
            onClick={() => {
              const mode = native ? 'pty' : 'sdk'
              if (finished) void handleSwitch(mode)
              else setSwitchTo(mode)
            }}
          >
            {native ? 'Use Terminal' : 'Use Native UI'}
          </Button>
        )}
      </header>

      {switchTo && (
        <div className="bg-muted space-y-2 border-b px-4 py-3">
          <p className="text-sm">
            End this runtime and resume the saved conversation in{' '}
            {switchTo === 'sdk' ? 'Native UI' : 'Terminal'}?
          </p>
          <p className="text-foreground text-xs">
            Current work is interrupted. Pending questions and permission requests do not transfer;
            ask Copilot again if needed. Your initial task is not sent again.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={resuming}
              onClick={() => setSwitchTo(null)}
            >
              Keep current mode
            </Button>
            <Button size="sm" disabled={resuming} onClick={() => void handleSwitch(switchTo)}>
              {resuming ? 'Switching...' : 'End and switch'}
            </Button>
          </div>
        </div>
      )}
      {actionError && (
        <p role="alert" className="text-destructive border-b px-4 py-2 text-sm">
          {actionError}
        </p>
      )}
      {observationIssue && !finished && (
        <p className="bg-muted border-b px-4 py-2 text-xs" role="status">
          {observationIssue} The terminal remains available.
        </p>
      )}
      {native ? (
        <>
          {currentSnapshot?.historyTruncated && (
            <p className="text-muted-foreground border-b px-4 py-2 text-xs">
              Showing the most recent 500 entries. Earlier entries remain in saved Copilot history.
            </p>
          )}
          <TerminalTimeline entries={entries} />
          <NativeSessionControls session={session} />
        </>
      ) : (
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
      )}
    </div>
  )
}
