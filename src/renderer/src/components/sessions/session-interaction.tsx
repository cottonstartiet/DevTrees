import * as React from 'react'
import { ArrowUpRightIcon, SendIcon, ShieldQuestionIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { MarkdownBody } from '@/components/pr-review/markdown-body'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import { nativeError } from '@/contexts/use-native-sessions'
import {
  initialNativeDraft,
  nativeFields,
  nativeFormContent,
  nativeKey,
  type NativeAnswer,
  type NativeField,
  type NativeInteraction
} from '@shared/native-session'
import { isTerminalSessionFinished, type TerminalSession } from '@shared/terminal-session'

const selectStyle =
  'bg-background border-input focus-visible:ring-ring w-full min-w-0 rounded-md border px-2 py-2 text-sm focus-visible:outline-none focus-visible:ring-3'

function Field({
  field,
  value,
  onChange,
  prefix
}: {
  field: NativeField
  value: string | boolean | string[] | undefined
  onChange: (value: string | boolean | string[] | undefined) => void
  prefix: string
}): React.JSX.Element {
  const id = `${prefix}-${field.name}`
  const helpId = field.description ? `${id}-help` : undefined
  let control: React.ReactNode
  if (field.type === 'array') {
    control = (
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {field.choices?.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary focus-visible:ring-ring size-4 focus-visible:ring-3"
              checked={Array.isArray(value) && value.includes(option.value)}
              onChange={(event) => {
                const selected = Array.isArray(value) ? value : []
                onChange(
                  event.target.checked
                    ? [...selected, option.value]
                    : selected.filter((item) => item !== option.value)
                )
              }}
            />
            {option.label}
          </label>
        ))}
      </div>
    )
  } else if (field.choices || field.type === 'boolean') {
    const options = field.choices ?? [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' }
    ]
    const selected =
      value === undefined
        ? ''
        : String(options.findIndex((option) => option.value === String(value)))
    control = (
      <select
        id={id}
        className={selectStyle}
        required={field.required}
        aria-describedby={helpId}
        value={selected}
        onChange={(event) => {
          const choice =
            event.target.value === '' ? undefined : options[Number(event.target.value)]?.value
          onChange(
            choice === undefined ? undefined : field.type === 'boolean' ? choice === 'true' : choice
          )
        }}
      >
        <option value="">Choose an answer</option>
        {options.map((option, index) => (
          <option key={option.value} value={index}>
            {option.label}
          </option>
        ))}
      </select>
    )
  } else {
    control = (
      <Input
        id={id}
        aria-describedby={helpId}
        value={typeof value === 'string' ? value : ''}
        required={field.required}
        type={field.type === 'string' ? 'text' : 'number'}
        step={field.type === 'integer' ? 1 : 'any'}
        min={field.minimum}
        max={field.maximum}
        minLength={field.minLength}
        maxLength={field.maxLength}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }
  if (field.type === 'array') {
    return (
      <fieldset className="space-y-2" aria-describedby={helpId}>
        <legend className="text-sm font-medium">
          {field.title}
          {field.required && ' (required)'}
        </legend>
        {field.description && (
          <p id={helpId} className="text-muted-foreground text-xs">
            {field.description}
          </p>
        )}
        {control}
      </fieldset>
    )
  }
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {field.title}
        {field.required && ' (required)'}
      </label>
      {field.description && (
        <p id={helpId} className="text-muted-foreground text-xs">
          {field.description}
        </p>
      )}
      {control}
    </div>
  )
}

export function SessionInteraction({
  session,
  interaction,
  compact = false,
  onOpenSession
}: {
  session: TerminalSession
  interaction: NativeInteraction
  compact?: boolean
  onOpenSession?: (requestId: string) => void
}): React.JSX.Element {
  const { nativeDrafts, setNativeDraft, nativeBusy, respondNative } = useTerminalSessions()
  const key = nativeKey(session, interaction.id)
  const busy = nativeBusy[key] === true
  const [validationError, setValidationError] = React.useState<string | null>(null)
  const prefix = React.useId()
  const parsed = React.useMemo(() => {
    if (interaction.kind !== 'elicitation' || interaction.url || interaction.unsupported)
      return { fields: [] }
    try {
      return { fields: nativeFields(interaction.schema) }
    } catch (error) {
      return { fields: [], error: nativeError(error) }
    }
  }, [interaction])
  const draft = nativeDrafts[key] ?? initialNativeDraft(parsed.fields)
  const setValue = (name: string, value: string | boolean | string[] | undefined): void => {
    const next = { ...draft }
    if (value === undefined) delete next[name]
    else
      Object.defineProperty(next, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      })
    setNativeDraft(key, next)
  }
  const submit = (answer: NativeAnswer, prepare?: () => Promise<void>): void => {
    setValidationError(null)
    void respondNative(session, interaction.id, answer, prepare)
  }
  const large =
    interaction.kind === 'plan' ||
    (interaction.kind === 'permission' && Boolean(interaction.diff)) ||
    (interaction.kind === 'elicitation' &&
      (parsed.fields.length !== 1 ||
        interaction.url ||
        interaction.unsupported ||
        parsed.error ||
        (!parsed.fields[0]?.choices && parsed.fields[0]?.type !== 'boolean') ||
        (parsed.fields[0]?.choices?.length ?? 0) > 6)) ||
    (interaction.kind === 'question' && interaction.choices.length > 6)

  return (
    <section
      id={`native-request-${interaction.id}`}
      tabIndex={-1}
      className="focus-visible:ring-ring space-y-3 outline-none focus-visible:ring-3"
      aria-label="Copilot request"
    >
      <div className="flex items-start gap-2">
        {interaction.kind === 'permission' && (
          <ShieldQuestionIcon className="mt-0.5 size-4 shrink-0" />
        )}
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm font-medium">
          {interaction.message}
        </p>
      </div>
      {compact && large ? (
        <Button size="sm" variant="outline" onClick={() => onOpenSession?.(interaction.id)}>
          Answer in session <ArrowUpRightIcon className="size-3.5" />
        </Button>
      ) : (
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          {interaction.kind === 'permission' && (
            <>
              {interaction.intention && (
                <p className="text-muted-foreground text-sm">{interaction.intention}</p>
              )}
              {interaction.target && (
                <pre className="bg-muted max-h-32 overflow-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap">
                  {interaction.target}
                </pre>
              )}
              {interaction.diff && (
                <pre className="bg-muted max-h-64 overflow-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap">
                  {interaction.diff}
                </pre>
              )}
              <p className="text-muted-foreground font-mono text-xs break-all">
                {session.folderPath}
              </p>
              <details className="group">
                <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring cursor-pointer list-none rounded-md text-xs focus-visible:ring-3 focus-visible:outline-none">
                  <span className="group-open:hidden">Show request details</span>
                  <span className="hidden group-open:inline">Hide request details</span>
                </summary>
                <pre className="bg-muted mt-2 max-h-48 overflow-auto rounded-md p-3 text-xs break-words whitespace-pre-wrap">
                  {interaction.detail}
                </pre>
              </details>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => submit({ kind: 'permission', action: 'deny' })}
                >
                  Deny
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => submit({ kind: 'permission', action: 'allow-once' })}
                >
                  Allow once
                </Button>
                {interaction.scopes.map((scope) => (
                  <Button
                    key={scope.action}
                    type="button"
                    size="sm"
                    variant="outline"
                    title={scope.description}
                    onClick={() => submit({ kind: 'permission', action: scope.action })}
                  >
                    {scope.label}
                  </Button>
                ))}
              </div>
              {interaction.scopes.length > 0 ? (
                <ul className="text-muted-foreground space-y-1 text-xs">
                  {interaction.scopes.map((scope) => (
                    <li key={scope.action}>
                      <span className="font-medium">{scope.label}:</span> {scope.description}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-xs">
                  {interaction.managed
                    ? 'Managed policy requires a decision on every one of these requests.'
                    : 'Copilot did not offer a broader scope for this request.'}
                </p>
              )}
            </>
          )}
          {interaction.kind === 'elicitation' && (
            <>
              {interaction.unsupported || parsed.error ? (
                <p role="alert" className="text-destructive text-sm">
                  {interaction.unsupported || parsed.error} Cancel this request or switch to
                  Terminal.
                </p>
              ) : interaction.url ? (
                <div className="space-y-2">
                  <p className="break-all font-mono text-xs">{interaction.url}</p>
                  <p className="text-muted-foreground text-xs">
                    Opens your browser. Consent to open is not a confirmation that sign-in has
                    completed.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      submit({ kind: 'elicitation', action: 'accept' }, async () => {
                        const result = await window.api.system.openExternal(interaction.url!)
                        if (!result.ok) throw new Error(result.error)
                      })
                    }
                  >
                    Open link and continue
                  </Button>
                </div>
              ) : (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    try {
                      submit({
                        kind: 'elicitation',
                        action: 'accept',
                        content: nativeFormContent(parsed.fields, draft)
                      })
                    } catch (error) {
                      setValidationError(nativeError(error))
                    }
                  }}
                >
                  {parsed.fields.map((field) => (
                    <Field
                      key={field.name}
                      field={field}
                      prefix={prefix}
                      value={Object.hasOwn(draft, field.name) ? draft[field.name] : undefined}
                      onChange={(value) => setValue(field.name, value)}
                    />
                  ))}
                  <Button type="submit" size="sm">
                    {busy ? 'Sending...' : 'Submit answer'}
                  </Button>
                </form>
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => submit({ kind: 'elicitation', action: 'decline' })}
                >
                  Decline
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => submit({ kind: 'elicitation', action: 'cancel' })}
                >
                  Cancel request
                </Button>
              </div>
            </>
          )}
          {interaction.kind === 'question' && (
            <>
              <div className="flex flex-wrap gap-2">
                {interaction.choices.map((choice) => (
                  <Button
                    key={choice}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-auto min-h-8 whitespace-normal text-left"
                    onClick={() => submit({ kind: 'question', answer: choice, wasFreeform: false })}
                  >
                    {choice}
                  </Button>
                ))}
              </div>
              {interaction.allowFreeform && (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    submit({
                      kind: 'question',
                      answer: String(draft.answer ?? ''),
                      wasFreeform: true
                    })
                  }}
                >
                  <Textarea
                    aria-label="Your answer"
                    value={String(draft.answer ?? '')}
                    onChange={(event) => setValue('answer', event.target.value)}
                    required
                  />
                  <Button type="submit" size="sm" disabled={!String(draft.answer ?? '').trim()}>
                    Send answer
                  </Button>
                </form>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => submit({ kind: 'cancel' })}
              >
                Cancel request
              </Button>
            </>
          )}
          {interaction.kind === 'plan' && (
            <>
              {interaction.plan && (
                <div className="max-h-72 overflow-auto">
                  <MarkdownBody text={interaction.plan} />
                </div>
              )}
              <Textarea
                aria-label="Plan feedback"
                placeholder="Feedback (optional)"
                value={String(draft.feedback ?? '')}
                onChange={(event) => setValue('feedback', event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    submit({
                      kind: 'plan',
                      approved: false,
                      feedback: String(draft.feedback ?? '')
                    })
                  }
                >
                  Request changes
                </Button>
                {interaction.actions.map((action) => (
                  <Button
                    key={action}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      submit({
                        kind: 'plan',
                        approved: true,
                        selectedAction: action,
                        feedback: String(draft.feedback ?? '')
                      })
                    }
                  >
                    Approve: {action.replaceAll('_', ' ')}
                  </Button>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => submit({ kind: 'cancel' })}
                >
                  Cancel request
                </Button>
              </div>
            </>
          )}
          {interaction.kind === 'autoMode' && (
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => submit({ kind: 'autoMode', approved: false })}
              >
                Keep current model
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => submit({ kind: 'autoMode', approved: true })}
              >
                Switch to Auto once
              </Button>
            </div>
          )}
        </fieldset>
      )}
      {validationError && (
        <p role="alert" className="text-destructive text-sm">
          {validationError}
        </p>
      )}
      {busy && (
        <p role="status" className="text-muted-foreground text-xs">
          Sending response...
        </p>
      )}
    </section>
  )
}

export function NativeSessionControls({
  session,
  compact = false,
  onOpenSession
}: {
  session: TerminalSession
  compact?: boolean
  onOpenSession?: (requestId: string) => void
}): React.JSX.Element | null {
  const {
    nativeById,
    nativeDrafts,
    nativeBusy,
    nativeErrors,
    setNativeDraft,
    promptNative,
    refreshNative
  } = useTerminalSessions()
  const snapshot = nativeById[session.id]
  const current = snapshot?.session.generation === session.generation ? snapshot : undefined
  const key = nativeKey(session)
  const draft = nativeDrafts[key] ?? {}
  const pending = current?.interactions ?? []
  const finished = isTerminalSessionFinished(session.status)
  const errors = Object.entries(nativeErrors).filter(
    ([identity, error]) =>
      error &&
      (identity === 'connection' || identity.startsWith(key.slice(0, key.lastIndexOf(','))))
  )
  if (finished && !current?.error && errors.length === 0) return null
  return (
    <div
      className={
        compact
          ? 'space-y-3 border-t p-3'
          : 'max-h-[60%] shrink-0 space-y-3 overflow-y-auto border-t p-4'
      }
    >
      {current?.error && (
        <p className="text-destructive text-sm" role="alert">
          {current.error}
        </p>
      )}
      {errors.map(([identity, error]) => (
        <p key={identity} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ))}
      {!finished && !current && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-sm">
            Native controls are not synchronized.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void refreshNative(session).catch((error) =>
                console.error('[native sessions] refresh:', error)
              )
            }}
          >
            Refresh controls
          </Button>
        </div>
      )}
      {pending.length > 0 && (
        <p role="status" className="text-muted-foreground text-xs">
          {pending.length} pending request{pending.length === 1 ? '' : 's'}
        </p>
      )}
      <div className="divide-y">
        {(compact ? pending.slice(0, 1) : pending).map((interaction) => (
          <div key={interaction.id} className="py-3 first:pt-0 last:pb-0">
            <SessionInteraction
              session={session}
              interaction={interaction}
              compact={compact}
              onOpenSession={onOpenSession}
            />
          </div>
        ))}
      </div>
      {compact && pending.length > 1 && (
        <Button size="sm" variant="ghost" onClick={() => onOpenSession?.(pending[1].id)}>
          View {pending.length - 1} more requests
        </Button>
      )}
      {!finished && (!compact || pending.length === 0) && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            void promptNative(session, String(draft.message ?? ''))
          }}
        >
          <label className="sr-only" htmlFor={`composer-${session.id}`}>
            Message Copilot
          </label>
          <Textarea
            id={`composer-${session.id}`}
            rows={compact ? 2 : 3}
            placeholder={
              session.status === 'idle'
                ? 'Message Copilot...'
                : 'Draft your next instruction while Copilot works...'
            }
            value={String(draft.message ?? '')}
            onChange={(event) => setNativeDraft(key, { message: event.target.value })}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              {session.status === 'idle'
                ? 'Your next instruction continues this conversation.'
                : 'Send when this turn has finished. Your draft is kept here.'}
            </p>
            {!compact && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={session.status !== 'idle' || nativeBusy[key]}
                onClick={() => void promptNative(session, '/plan', false)}
              >
                Enter plan mode
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              disabled={
                session.status !== 'idle' ||
                !current ||
                nativeBusy[key] ||
                !String(draft.message ?? '').trim()
              }
            >
              <SendIcon className="size-3.5" /> {nativeBusy[key] ? 'Sending...' : 'Send'}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
