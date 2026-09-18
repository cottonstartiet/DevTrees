import * as React from 'react'
import { ArrowUpRightIcon } from 'lucide-react'

import {
  acpPermissionOptionScope,
  initialNativeDraft,
  nativeFields,
  nativeFormContent,
  nativeInteractionRequiresFullSession,
  nativeKey,
  nativeSessionCanReopenPlanTransition,
  orderedAcpPermissionOptions,
  type NativeAnswer,
  type NativeField,
  type NativeInteraction,
  type PlanTransitionAction
} from '@shared/native-session'
import type { TerminalSession } from '@shared/terminal-session'
import { useRemoteNativeSessions } from './native-session-store'

const controlClass =
  'remote-touch w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
const buttonClass =
  'remote-touch rounded-md border bg-background px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'

function fieldValue(
  field: NativeField,
  value: string | boolean | string[] | undefined,
  setValue: (value: string | boolean | string[] | undefined) => void
): React.ReactNode {
  if (field.type === 'array') {
    return (
      <div className="flex flex-wrap gap-3">
        {field.choices?.map((choice) => (
          <label key={choice.value} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Array.isArray(value) && value.includes(choice.value)}
              onChange={(event) => {
                const selected = Array.isArray(value) ? value : []
                setValue(
                  event.target.checked
                    ? [...selected, choice.value]
                    : selected.filter((item) => item !== choice.value)
                )
              }}
              className="size-4"
            />
            {choice.label}
          </label>
        ))}
      </div>
    )
  }
  if (field.choices || field.type === 'boolean') {
    const choices = field.choices ?? [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' }
    ]
    return (
      <select
        value={value === undefined ? '' : String(value)}
        required={field.required}
        onChange={(event) => {
          const next = event.target.value
          setValue(
            next === '' ? undefined : field.type === 'boolean' ? next === 'true' : next
          )
        }}
        className={controlClass}
      >
        <option value="">Choose an answer</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    )
  }
  return (
    <input
      value={typeof value === 'string' ? value : ''}
      required={field.required}
      type={field.type === 'string' ? 'text' : 'number'}
      step={field.type === 'integer' ? 1 : 'any'}
      min={field.minimum}
      max={field.maximum}
      minLength={field.minLength}
      maxLength={field.maxLength}
      onChange={(event) => setValue(event.target.value)}
      className={controlClass}
    />
  )
}

function NativeFieldControl({
  field,
  value,
  setValue
}: {
  field: NativeField
  value: string | boolean | string[] | undefined
  setValue: (value: string | boolean | string[] | undefined) => void
}): React.JSX.Element {
  if (field.type === 'array') {
    return (
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">
          {field.title}
          {field.required ? ' (required)' : ''}
        </legend>
        {field.description ? (
          <p className="text-xs font-normal text-muted-foreground">{field.description}</p>
        ) : null}
        {fieldValue(field, value, setValue)}
      </fieldset>
    )
  }
  return (
    <label className="space-y-1.5 text-sm font-medium">
      <span>
        {field.title}
        {field.required ? ' (required)' : ''}
      </span>
      {field.description ? (
        <span className="block text-xs font-normal text-muted-foreground">
          {field.description}
        </span>
      ) : null}
      {fieldValue(field, value, setValue)}
    </label>
  )
}

export function RemoteSessionInteraction({
  session,
  interaction,
  compact = false,
  onOpenSession
}: {
  session: TerminalSession
  interaction: NativeInteraction
  compact?: boolean
  onOpenSession: (requestId: string) => void
}): React.JSX.Element {
  const { drafts, setDraft, busy, errors, respond } = useRemoteNativeSessions()
  const key = nativeKey(session, interaction.id)
  const isBusy = busy[key] === true
  const error = errors[key]
  const [validationError, setValidationError] = React.useState('')
  const parsed = React.useMemo(() => {
    if (interaction.kind !== 'elicitation' || interaction.url || interaction.unsupported) {
      return { fields: [] as NativeField[] }
    }
    try {
      return { fields: nativeFields(interaction.schema) }
    } catch (parseError) {
      return {
        fields: [] as NativeField[],
        error: parseError instanceof Error ? parseError.message : String(parseError)
      }
    }
  }, [interaction])
  const draft = drafts[key] ?? initialNativeDraft(parsed.fields)
  const setValue = (name: string, value: string | boolean | string[] | undefined): void => {
    setDraft(key, (current) => {
      const next = { ...current }
      if (value === undefined) delete next[name]
      else next[name] = value
      return next
    })
  }
  const submit = (answer: NativeAnswer, prepare?: () => Promise<void>): void => {
    setValidationError('')
    void respond(session, interaction.id, answer, prepare)
  }

  if (compact && nativeInteractionRequiresFullSession(interaction)) {
    return (
      <div className="space-y-2">
        <p className="whitespace-pre-wrap break-words text-sm font-medium">
          {interaction.message}
        </p>
        <button
          type="button"
          onClick={() => onOpenSession(interaction.id)}
          className={buttonClass}
        >
          Answer in session <ArrowUpRightIcon className="ml-1 inline size-3.5" />
        </button>
      </div>
    )
  }

  return (
    <section
      id={`native-request-${interaction.id}`}
      tabIndex={-1}
      aria-label="Copilot request"
      className="space-y-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <p className="whitespace-pre-wrap break-words text-sm font-medium">
        {interaction.message}
      </p>
      <fieldset disabled={isBusy} className="space-y-3">
        {interaction.kind === 'acpPermission' ? (
          <>
            {!compact ? (
              <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                {interaction.detail}
              </pre>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => submit({ kind: 'cancel' })}
                className={buttonClass}
              >
                Cancel
              </button>
              {orderedAcpPermissionOptions(interaction.options).map((option) => (
                <button
                  key={option.optionId}
                  type="button"
                  title={acpPermissionOptionScope(option.kind)}
                  onClick={() =>
                    submit({ kind: 'permission', action: option.optionId })
                  }
                  className={buttonClass}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </>
        ) : null}
        {interaction.kind === 'permission' ? (
          <>
            {interaction.intention ? (
              <p className="text-sm text-muted-foreground">{interaction.intention}</p>
            ) : null}
            {interaction.target ? (
              <pre className="max-h-32 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">
                {interaction.target}
              </pre>
            ) : null}
            {interaction.diff ? (
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">
                {interaction.diff}
              </pre>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => submit({ kind: 'permission', action: 'deny' })}
                className={buttonClass}
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => submit({ kind: 'permission', action: 'allow-once' })}
                className={buttonClass}
              >
                Allow once
              </button>
              {interaction.scopes.map((scope) => (
                <button
                  key={scope.action}
                  type="button"
                  title={scope.description}
                  onClick={() => submit({ kind: 'permission', action: scope.action })}
                  className={buttonClass}
                >
                  {scope.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
        {interaction.kind === 'elicitation' ? (
          <>
            {interaction.unsupported || parsed.error ? (
              <p role="alert" className="text-sm text-destructive">
                {interaction.unsupported || parsed.error}
              </p>
            ) : interaction.url ? (
              <div className="space-y-2">
                <p className="break-all font-mono text-xs">{interaction.url}</p>
                <button
                  type="button"
                  onClick={() =>
                    submit({ kind: 'elicitation', action: 'accept' }, async () => {
                      const url = new URL(interaction.url!)
                      if (!['http:', 'https:'].includes(url.protocol)) {
                        throw new Error('This link uses an unsupported protocol.')
                      }
                      window.open(url.href, '_blank', 'noopener,noreferrer')
                    })
                  }
                  className={buttonClass}
                >
                  Open link and continue
                </button>
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
                  } catch (submitError) {
                    setValidationError(
                      submitError instanceof Error ? submitError.message : String(submitError)
                    )
                  }
                }}
              >
                {parsed.fields.map((field) => (
                  <NativeFieldControl
                    key={field.name}
                    field={field}
                    value={draft[field.name]}
                    setValue={(value) => setValue(field.name, value)}
                  />
                ))}
                <button type="submit" className={buttonClass}>
                  Submit answer
                </button>
              </form>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => submit({ kind: 'elicitation', action: 'decline' })}
                className={buttonClass}
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => submit({ kind: 'elicitation', action: 'cancel' })}
                className={buttonClass}
              >
                Cancel request
              </button>
            </div>
          </>
        ) : null}
        {interaction.kind === 'question' ? (
          <>
            <div className="flex flex-wrap gap-2">
              {interaction.choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  onClick={() =>
                    submit({ kind: 'question', answer: choice, wasFreeform: false })
                  }
                  className={buttonClass}
                >
                  {choice}
                </button>
              ))}
            </div>
            {interaction.allowFreeform ? (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  const answer = String(draft.answer ?? '').trim()
                  if (answer) {
                    submit({ kind: 'question', answer, wasFreeform: true })
                  }
                }}
              >
                <input
                  aria-label="Your answer"
                  value={String(draft.answer ?? '')}
                  onChange={(event) => setValue('answer', event.target.value)}
                  className={controlClass}
                />
                <button
                  type="submit"
                  disabled={!String(draft.answer ?? '').trim()}
                  className={buttonClass}
                >
                  Send
                </button>
              </form>
            ) : null}
            <button
              type="button"
              onClick={() => submit({ kind: 'cancel' })}
              className={buttonClass}
            >
              Cancel request
            </button>
          </>
        ) : null}
        {interaction.kind === 'plan' ? (
          <>
            {interaction.plan ? (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                {interaction.plan}
              </pre>
            ) : null}
            <textarea
              aria-label="Plan feedback"
              placeholder="Feedback (optional)"
              value={String(draft.feedback ?? '')}
              onChange={(event) => setValue('feedback', event.target.value)}
              className="min-h-20 w-full rounded-md border bg-background p-3 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  submit({
                    kind: 'plan',
                    approved: false,
                    feedback: String(draft.feedback ?? '')
                  })
                }
                className={buttonClass}
              >
                Request changes
              </button>
              {interaction.actions.map((selectedAction) => (
                <button
                  key={selectedAction}
                  type="button"
                  onClick={() =>
                    submit({
                      kind: 'plan',
                      approved: true,
                      selectedAction,
                      feedback: String(draft.feedback ?? '')
                    })
                  }
                  className={buttonClass}
                >
                  Approve: {selectedAction.replaceAll('_', ' ')}
                </button>
              ))}
              <button
                type="button"
                onClick={() => submit({ kind: 'cancel' })}
                className={buttonClass}
              >
                Cancel request
              </button>
            </div>
          </>
        ) : null}
        {interaction.kind === 'autoMode' ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => submit({ kind: 'autoMode', approved: false })}
              className={buttonClass}
            >
              Keep current model
            </button>
            <button
              type="button"
              onClick={() => submit({ kind: 'autoMode', approved: true })}
              className={buttonClass}
            >
              Switch to Auto once
            </button>
          </div>
        ) : null}
      </fieldset>
      {validationError || error ? (
        <p role="alert" className="text-sm text-destructive">
          {validationError || error}
        </p>
      ) : null}
      {isBusy ? (
        <p role="status" className="text-xs text-muted-foreground">
          Sending response...
        </p>
      ) : null}
    </section>
  )
}

export function RemotePlanCompletion({
  session,
  compact = false,
  onOpenSession
}: {
  session: TerminalSession
  compact?: boolean
  onOpenSession: (requestId?: string) => void
}): React.JSX.Element | null {
  const { snapshots, drafts, setDraft, busy, errors, prompt, transitionPlan, reopenPlan } =
    useRemoteNativeSessions()
  const snapshot = snapshots[session.id]
  const current =
    snapshot?.session.generation === session.generation ? snapshot : undefined
  const transitionKey = nativeKey(session, 'plan-transition')
  const reopenKey = nativeKey(session, 'plan-reopen')
  const replyKey = nativeKey(session, 'plan-followup')
  const transitionBusy = busy[transitionKey] === true
  const reopenBusy = busy[reopenKey] === true
  const replyBusy = busy[replyKey] === true
  const canReopen = nativeSessionCanReopenPlanTransition(session, current)
  if (
    !current ||
    current.interactions.length > 0 ||
    (!current.planTransitionAvailable && !transitionBusy && !canReopen && !reopenBusy)
  ) {
    return null
  }
  if (canReopen || reopenBusy) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">This session is still in Plan mode.</p>
        <button
          type="button"
          disabled={reopenBusy}
          onClick={() => void reopenPlan(session)}
          className={buttonClass}
        >
          {reopenBusy ? 'Opening choices...' : 'Choose implementation mode'}
        </button>
      </div>
    )
  }
  const fleetAvailable = (current.commands ?? []).some(
    (command) => command.name.toLowerCase() === 'fleet'
  )
  const choices: { action: PlanTransitionAction; label: string; disabled?: boolean }[] = [
    { action: 'exit_only', label: 'Exit plan mode' },
    { action: 'interactive', label: 'Build on default permissions' },
    { action: 'autopilot', label: 'Build on autopilot' },
    {
      action: 'autopilot_fleet',
      label: 'Build on autopilot with fleet',
      disabled: !fleetAvailable
    }
  ]
  return (
    <section className="space-y-3">
      <div>
        <p className="text-sm font-medium">Plan complete. Choose the next step.</p>
        <p className="text-xs text-muted-foreground">
          {compact
            ? 'Continue directly, or open the session to refine the plan.'
            : 'Reply to refine the plan, or continue to implementation.'}
        </p>
      </div>
      {!compact ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            const message = String(drafts[replyKey]?.message ?? '').trim()
            if (message) void prompt(session, message, 'plan-followup')
          }}
        >
          <textarea
            aria-label="Plan refinement"
            value={String(drafts[replyKey]?.message ?? '')}
            onChange={(event) => setDraft(replyKey, { message: event.target.value })}
            placeholder="Refine the plan..."
            className="min-h-20 w-full rounded-md border bg-background p-3 text-sm"
          />
          <button
            type="submit"
            disabled={replyBusy || !String(drafts[replyKey]?.message ?? '').trim()}
            className={buttonClass}
          >
            {replyBusy ? 'Sending...' : 'Send refinement'}
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => onOpenSession()} className={buttonClass}>
          Refine in session <ArrowUpRightIcon className="ml-1 inline size-3.5" />
        </button>
      )}
      <div className="flex flex-wrap gap-2">
        {choices.map((choice) => (
          <button
            key={choice.action}
            type="button"
            disabled={transitionBusy || replyBusy || choice.disabled}
            title={
              choice.disabled ? 'This session does not advertise the /fleet command.' : undefined
            }
            onClick={() => void transitionPlan(session, choice.action)}
            className={buttonClass}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {errors[transitionKey] || errors[replyKey] || errors[reopenKey] ? (
        <p role="alert" className="text-sm text-destructive">
          {errors[transitionKey] || errors[replyKey] || errors[reopenKey]}
        </p>
      ) : null}
    </section>
  )
}
