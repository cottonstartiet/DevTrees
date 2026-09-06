import * as React from 'react'
import { CircleAlertIcon, Loader2Icon, RefreshCwIcon, SendIcon, SquareIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import { cn } from '@/lib/utils'
import type { TerminalSession, TerminalSessionInteraction } from '@shared/terminal-session'

type SchemaProperty = {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: string[]
  oneOf?: Array<{ const?: unknown; title?: string }>
  items?: {
    enum?: string[]
    anyOf?: Array<{ const?: unknown; title?: string }>
  }
}

function schemaProperties(
  interaction: Extract<TerminalSessionInteraction, { kind: 'elicitation' }>
): Record<string, SchemaProperty> {
  const properties = interaction.requestedSchema?.properties
  return properties && typeof properties === 'object'
    ? (properties as Record<string, SchemaProperty>)
    : {}
}

function initialValues(properties: Record<string, SchemaProperty>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, property]) => [
      key,
      property.default ??
        (property.type === 'boolean'
          ? false
          : property.type === 'array'
            ? []
            : (property.oneOf?.[0]?.const ?? property.enum?.[0] ?? ''))
    ])
  )
}

function responseErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Could not send the response.'
}

export function SessionInteraction({
  session,
  interaction,
  compact = false,
  onOpenSession
}: {
  session: TerminalSession
  interaction?: TerminalSessionInteraction
  compact?: boolean
  onOpenSession?: () => void
}): React.JSX.Element | null {
  const { prompt, respond, cancel, refreshInteraction } = useTerminalSessions()
  const [value, setValue] = React.useState('')
  const [values, setValues] = React.useState<Record<string, unknown>>(() =>
    interaction?.kind === 'elicitation' && interaction.mode === 'form'
      ? initialValues(schemaProperties(interaction))
      : {}
  )
  const [submitting, setSubmitting] = React.useState(false)

  const run = async (action: () => Promise<void>, success?: string): Promise<void> => {
    setSubmitting(true)
    try {
      await action()
      if (success) toast.success(success)
    } catch (error) {
      toast.error(responseErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  if (interaction?.kind === 'permission') {
    return (
      <div className={cn('space-y-2', compact && 'border-t px-3 py-2')}>
        <p className="text-xs font-medium">{interaction.message}</p>
        <div className="flex flex-wrap gap-2">
          {interaction.options.map((option) => (
            <Button
              key={option.optionId}
              size="sm"
              variant={option.kind.startsWith('reject') ? 'outline' : 'default'}
              disabled={submitting}
              onClick={() =>
                void run(() =>
                  respond({
                    id: session.id,
                    requestId: interaction.requestId,
                    kind: 'permission',
                    optionId: option.optionId
                  })
                )
              }
            >
              {submitting && <Loader2Icon className="size-3.5 animate-spin" />}
              {option.name}
            </Button>
          ))}
        </div>
      </div>
    )
  }

  if (interaction?.kind === 'elicitation') {
    if (interaction.mode === 'url') {
      return (
        <div className={cn('space-y-2', compact && 'border-t px-3 py-2')}>
          <p className="text-xs font-medium">{interaction.message}</p>
          {interaction.url && (
            <p className="text-muted-foreground break-all text-[11px]">{interaction.url}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={submitting || !interaction.url}
              onClick={() =>
                void run(async () => {
                  if (!interaction.url) return
                  const result = await window.api.system.openExternal(interaction.url)
                  if (!result.ok) throw new Error(result.error)
                  await respond({
                    id: session.id,
                    requestId: interaction.requestId,
                    kind: 'elicitation',
                    action: 'accept'
                  })
                })
              }
            >
              Open link
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() =>
                void run(() =>
                  respond({
                    id: session.id,
                    requestId: interaction.requestId,
                    kind: 'elicitation',
                    action: 'decline'
                  })
                )
              }
            >
              Decline
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={submitting}
              onClick={() =>
                void run(() =>
                  respond({
                    id: session.id,
                    requestId: interaction.requestId,
                    kind: 'elicitation',
                    action: 'cancel'
                  })
                )
              }
            >
              Cancel
            </Button>
          </div>
        </div>
      )
    }

    const properties = schemaProperties(interaction)
    if (compact && Object.keys(properties).length > 1) {
      return (
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <p className="min-w-0 flex-1 truncate text-xs">{interaction.message}</p>
          <Button size="sm" onClick={onOpenSession}>
            Respond
          </Button>
        </div>
      )
    }

    return (
      <form
        className={cn('space-y-3', compact && 'border-t px-3 py-2')}
        onSubmit={(event) => {
          event.preventDefault()
          void run(() =>
            respond({
              id: session.id,
              requestId: interaction.requestId,
              kind: 'elicitation',
              action: 'accept',
              content: values
            })
          )
        }}
      >
        <p className="text-xs font-medium">{interaction.message}</p>
        {Object.entries(properties).map(([key, property]) => {
          const options =
            property.oneOf?.map((option) => ({
              value: String(option.const ?? ''),
              label: option.title ?? String(option.const ?? '')
            })) ?? property.enum?.map((option) => ({ value: option, label: option }))
          const arrayOptions =
            property.items?.anyOf?.map((option) => ({
              value: String(option.const ?? ''),
              label: option.title ?? String(option.const ?? '')
            })) ?? property.items?.enum?.map((option) => ({ value: option, label: option }))
          const label = property.title ?? key
          const inputId = `session-${session.id}-${interaction.requestId}-${key}`
          return (
            <div key={key} className="space-y-1">
              <label className="block text-xs font-medium" htmlFor={inputId}>
                {label}
              </label>
              {property.type === 'array' && arrayOptions ? (
                <div id={inputId} className="flex flex-wrap gap-2">
                  {arrayOptions.map((option) => {
                    const selected = Array.isArray(values[key])
                      ? (values[key] as unknown[]).map(String)
                      : []
                    return (
                      <label
                        key={option.value}
                        className="hover:bg-accent flex min-h-9 items-center gap-2 rounded-md border px-3 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={selected.includes(option.value)}
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [key]: event.target.checked
                                ? [...selected, option.value]
                                : selected.filter((value) => value !== option.value)
                            }))
                          }
                        />
                        {option.label}
                      </label>
                    )
                  })}
                </div>
              ) : options ? (
                <select
                  id={inputId}
                  className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
                  value={String(values[key] ?? '')}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [key]: event.target.value }))
                  }
                >
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : property.type === 'boolean' ? (
                <span className="hover:bg-accent flex min-h-9 items-center gap-2 rounded-md border px-3 text-xs">
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={Boolean(values[key])}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [key]: event.target.checked }))
                    }
                  />
                  {property.description ?? `Enable ${label}`}
                </span>
              ) : (
                <Input
                  id={inputId}
                  type={
                    property.type === 'number' || property.type === 'integer' ? 'number' : 'text'
                  }
                  value={String(values[key] ?? '')}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [key]:
                        property.type === 'number' || property.type === 'integer'
                          ? event.target.value === ''
                            ? ''
                            : event.target.valueAsNumber
                          : event.target.value
                    }))
                  }
                />
              )}
              {property.description && (
                <span className="text-muted-foreground block text-[11px]">
                  {property.description}
                </span>
              )}
            </div>
          )
        })}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" disabled={submitting}>
            {submitting && <Loader2Icon className="size-3.5 animate-spin" />}
            Send response
          </Button>
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() =>
              void run(() =>
                respond({
                  id: session.id,
                  requestId: interaction.requestId,
                  kind: 'elicitation',
                  action: 'decline'
                })
              )
            }
          >
            Decline
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={() =>
              void run(() =>
                respond({
                  id: session.id,
                  requestId: interaction.requestId,
                  kind: 'elicitation',
                  action: 'cancel'
                })
              )
            }
          >
            Cancel
          </Button>
        </div>
      </form>
    )
  }

  if (session.status === 'waiting-input') {
    return (
      <div
        className={cn(
          'flex items-start gap-3 border-t bg-amber-500/[0.035] px-4 py-3',
          compact && 'px-3 py-2'
        )}
        role="status"
      >
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">Response controls are reconnecting</p>
          <p className="text-muted-foreground mt-0.5 text-[11px] leading-relaxed">
            {session.pendingPrompt ??
              'Copilot is waiting, but the app has not received the response options yet.'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {compact && onOpenSession ? (
            <Button size="sm" variant="outline" onClick={onOpenSession}>
              Open session
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={submitting}
            onClick={() =>
              void run(async () => {
                const recovered = await refreshInteraction(session.id)
                if (!recovered) {
                  throw new Error(
                    'Response controls are still unavailable. If this session was opened in an external terminal, respond there.'
                  )
                }
              })
            }
          >
            {submitting ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            Retry
          </Button>
        </div>
      </div>
    )
  }

  if (session.status === 'working' || session.status === 'starting') {
    if (compact) return null
    return (
      <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
        <p className="text-muted-foreground text-xs">Copilot is working.</p>
        <Button
          size="sm"
          variant="outline"
          disabled={submitting}
          onClick={() => void run(() => cancel(session.id))}
        >
          <SquareIcon className="size-3" />
          Stop
        </Button>
      </div>
    )
  }

  if (session.status === 'done' || session.status === 'error') return null

  return (
    <form
      className={cn('flex items-end gap-2 border-t px-4 py-3', compact && 'px-3 py-2')}
      onSubmit={(event) => {
        event.preventDefault()
        const next = value.trim()
        if (!next) return
        void run(async () => {
          await prompt(session.id, next)
          setValue('')
        })
      }}
    >
      <label className="min-w-0 flex-1 space-y-1">
        {!compact && <span className="text-xs font-medium">Message Copilot</span>}
        <Textarea
          rows={compact ? 1 : 2}
          className={cn('min-h-9 resize-none', compact && 'h-9 min-h-9 py-2')}
          value={value}
          placeholder="Continue the session…"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
      </label>
      <Button size="icon" type="submit" disabled={submitting || !value.trim()} aria-label="Send">
        {submitting ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <SendIcon className="size-4" />
        )}
      </Button>
    </form>
  )
}
