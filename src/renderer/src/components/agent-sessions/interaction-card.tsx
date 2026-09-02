import * as React from 'react'
import { AlertTriangleIcon, MessageSquareIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { AgentPendingInteraction } from '@shared/agent-session'

export function InteractionCard({
  interaction,
  onApprove,
  onReject,
  onAnswer
}: {
  interaction: AgentPendingInteraction
  onApprove: () => Promise<void>
  onReject: () => Promise<void>
  onAnswer: (answer: string, wasFreeform: boolean) => Promise<void>
}): React.JSX.Element {
  const [answer, setAnswer] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const run = React.useCallback(async (action: () => Promise<void>): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not continue the session.')
      setSubmitting(false)
    }
  }, [])

  if (interaction.kind === 'permission') {
    return (
      <section className="bg-card rounded-md border p-3">
        <div className="flex items-start gap-2">
          <AlertTriangleIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <h4 className="text-xs font-semibold">Permission required</h4>
            <p className="text-muted-foreground mt-1 text-xs">{interaction.description}</p>
            {interaction.toolName ? (
              <code className="bg-muted mt-2 inline-block rounded px-1.5 py-0.5 font-mono text-[10px]">
                {interaction.toolName}
              </code>
            ) : null}
          </div>
        </div>
        {error ? <p className="text-destructive mt-2 text-xs">{error}</p> : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => void run(onReject)}
          >
            Reject
          </Button>
          <Button size="sm" disabled={submitting} onClick={() => void run(onApprove)}>
            Approve once
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="bg-card rounded-md border p-3">
      <div className="flex items-start gap-2">
        <MessageSquareIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <h4 className="text-xs font-semibold">Copilot needs input</h4>
          <p className="mt-1 text-sm">{interaction.question}</p>
        </div>
      </div>
      {interaction.choices?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {interaction.choices.map((choice) => (
            <Button
              key={choice}
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => void run(() => onAnswer(choice, false))}
            >
              {choice}
            </Button>
          ))}
        </div>
      ) : null}
      {interaction.allowFreeform ? (
        <div className="mt-3 flex items-end gap-2">
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={2}
            disabled={submitting}
            placeholder="Type your response"
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 min-h-16 flex-1 resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-3"
          />
          <Button
            size="sm"
            disabled={submitting || !answer.trim()}
            onClick={() => void run(() => onAnswer(answer.trim(), true))}
          >
            Continue
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-destructive mt-2 text-xs">{error}</p> : null}
    </section>
  )
}
