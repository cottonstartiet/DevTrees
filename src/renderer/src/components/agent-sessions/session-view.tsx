import * as React from 'react'
import { CircleStopIcon, Loader2Icon, SendIcon } from 'lucide-react'

import { AgentTimeline } from '@/components/agent-sessions/timeline'
import { InteractionCard } from '@/components/agent-sessions/interaction-card'
import { RawEventLog } from '@/components/agent-sessions/raw-event-log'
import { Button } from '@/components/ui/button'
import { useAgentSessions } from '@/contexts/agent-sessions-context'
import { cn } from '@/lib/utils'
import type { AgentSession } from '@shared/agent-session'

const LIFECYCLE_LABELS: Record<AgentSession['lifecycle'], string> = {
  initializing: 'Starting',
  active: 'Working',
  idle: 'Ready',
  waiting_for_user: 'Needs input',
  waiting_for_permission: 'Permission required',
  failed: 'Failed',
  stopped: 'Stopped'
}

export function AgentSessionView({ session }: { session: AgentSession }): React.JSX.Element {
  const { eventsBySessionId, pendingBySessionId, send, abort, resolvePermission, answerUserInput } =
    useAgentSessions()
  const [draft, setDraft] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const events = eventsBySessionId[session.id] ?? []
  const pending = pendingBySessionId[session.id] ?? []
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const canSend = session.purpose === 'interactive' && session.lifecycle === 'idle'
  const canAbort =
    session.lifecycle === 'active' ||
    session.lifecycle === 'waiting_for_permission' ||
    session.lifecycle === 'waiting_for_user'

  React.useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [events.length, pending.length])

  const submit = React.useCallback(async (): Promise<void> => {
    const prompt = draft.trim()
    if (!prompt || !canSend) return
    setError(null)
    try {
      await send(session.id, prompt)
      setDraft('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the message.')
    }
  }, [canSend, draft, send, session.id])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="bg-muted/15 flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold">{session.label}</p>
          <p className="text-muted-foreground truncate font-mono text-[10px]">
            {session.currentIntent || session.folderPath}
          </p>
        </div>
        <span
          className={cn(
            'text-muted-foreground flex items-center gap-1.5 text-[10px]',
            session.lifecycle === 'failed' && 'text-destructive'
          )}
        >
          {session.lifecycle === 'active' || session.lifecycle === 'initializing' ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : null}
          {LIFECYCLE_LABELS[session.lifecycle]}
        </span>
        {canAbort ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2"
            onClick={() => void abort(session.id)}
          >
            <CircleStopIcon className="size-3.5" />
            Stop turn
          </Button>
        ) : null}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <AgentTimeline session={session} events={events} />
        {pending.length ? (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-6 pb-5">
            {pending.map((interaction) => (
              <InteractionCard
                key={interaction.id}
                interaction={interaction}
                onApprove={() =>
                  resolvePermission({
                    sessionId: session.id,
                    interactionId: interaction.id,
                    decision: 'approve_once'
                  })
                }
                onReject={() =>
                  resolvePermission({
                    sessionId: session.id,
                    interactionId: interaction.id,
                    decision: 'reject'
                  })
                }
                onAnswer={(answer, wasFreeform) =>
                  answerUserInput(session.id, interaction.id, answer, wasFreeform)
                }
              />
            ))}
          </div>
        ) : null}
      </div>

      {session.purpose === 'interactive' ? (
        <div className="bg-background shrink-0 border-t p-3">
          <div className="focus-within:ring-ring/50 mx-auto flex max-w-4xl items-end gap-2 rounded-md border bg-card p-2 shadow-xs focus-within:ring-3">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  void submit()
                }
              }}
              rows={2}
              disabled={!canSend}
              placeholder={canSend ? 'Ask Copilot…' : LIFECYCLE_LABELS[session.lifecycle]}
              className="min-h-10 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none disabled:opacity-60"
            />
            <Button
              size="icon"
              className="size-8"
              disabled={!canSend || !draft.trim()}
              onClick={() => void submit()}
            >
              <SendIcon className="size-3.5" />
              <span className="sr-only">Send message</span>
            </Button>
          </div>
          {error ? (
            <p className="text-destructive mx-auto mt-2 max-w-4xl text-xs">{error}</p>
          ) : null}
        </div>
      ) : null}
      <RawEventLog events={events} />
    </div>
  )
}
