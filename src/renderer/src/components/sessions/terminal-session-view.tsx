import * as React from 'react'
import { ExternalLinkIcon, FolderGitIcon, GitBranchIcon, Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'

import {
  TERMINAL_SESSION_STATUS_LABEL,
  TERMINAL_SESSION_STATUS_TONE
} from '@/components/sessions/terminal-session-status'
import { TerminalTimeline } from '@/components/sessions/terminal-timeline'
import { NativeSessionControls } from '@/components/sessions/session-interaction'
import { endedNativeHistory, nativeKey } from '@shared/native-session'
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
 * Native chat and external status share metadata, not interaction controls.
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
    selectedInteractionId
  } = useTerminalSessions()
  const launch = useCopilotLauncher()
  const [resuming, setResuming] = React.useState(false)
  const native = session.transport === 'sdk'
  const snapshot = nativeById[session.id]
  const currentSnapshot = snapshot?.session.generation === session.generation ? snapshot : undefined
  const focusedRequest = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (session.transport !== 'external' && (!native || isTerminalSessionFinished(session.status)))
      void loadHistory(session.id)
  }, [session.id, session.status, session.transport, native, loadHistory])

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
        taskId: session.taskId ?? undefined
      })
      if (result.ok) toast.success(`Resuming ${session.label} using the mode selected in Settings.`)
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
            <span className="text-muted-foreground text-xs">
              {native
                ? 'In-app chat'
                : session.transport === 'external'
                  ? 'External Copilot terminal'
                  : 'Previous session'}
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
        {native && session.status !== 'done' && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={
                finished || session.status === 'idle' || nativeBusy[nativeKey(session, 'lifecycle')]
              }
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
      </header>

      {observationIssue && !finished && (
        <p className="bg-muted border-b px-4 py-2 text-xs" role="status">
          {observationIssue}
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
      ) : session.transport === 'external' ? (
        <div className="space-y-3 p-4">
          <p className="text-sm" role="status">
            {session.pendingPrompt || session.lastActivity}
          </p>
          <p className="text-muted-foreground text-sm">Respond in the external Copilot terminal.</p>
          <p className="text-muted-foreground max-w-prose text-xs">
            This view shows live status only. It disappears when Copilot ends and is not restored
            after restarting DevTrees. Closing DevTrees leaves the external terminal running.
          </p>
        </div>
      ) : (
        <TerminalTimeline entries={entries} />
      )}
    </div>
  )
}
