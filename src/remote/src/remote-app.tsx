import * as React from 'react'
import {
  ArrowLeftIcon,
  BotIcon,
  CircleAlertIcon,
  GaugeIcon,
  KanbanSquareIcon,
  LoaderCircleIcon,
  PlayIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  SquareIcon,
  SquareTerminalIcon,
  Trash2Icon,
  WifiOffIcon
} from 'lucide-react'

import type { NativeAnswer, NativeInteraction, NativeSnapshot } from '@shared/native-session'
import type { Task, TaskStatus } from '@shared/task'
import type { TerminalSession, TerminalTimelineEntry } from '@shared/terminal-session'

type View = 'dashboard' | 'tasks' | 'sessions'
type SocketSnapshot = { type: 'snapshot'; tasks: Task[]; sessions: TerminalSession[] }

const STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'review', 'done']
const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done'
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET'
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-devtrees-lan': '1' }),
      ...init.headers
    }
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(body || `Request failed (${response.status}).`)
  }
  return response.json() as Promise<T>
}

function StatusDot({ status }: { status: TerminalSession['status'] }): React.JSX.Element {
  const tone =
    status === 'error'
      ? 'bg-destructive'
      : status === 'waiting-input'
        ? 'bg-amber-500'
        : status === 'working' || status === 'starting'
          ? 'bg-blue-500'
          : status === 'done'
            ? 'bg-muted-foreground/50'
            : 'bg-emerald-500'
  return <span className={`size-2 shrink-0 rounded-full ${tone}`} />
}

function PairingGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = React.useState<'pairing' | 'ready' | 'expired' | 'error'>('pairing')
  const [message, setMessage] = React.useState('')

  React.useEffect(() => {
    const secret = location.hash.slice(1)
    const pair = secret
      ? request<{ ok: true }>('/api/pair', {
          method: 'POST',
          body: JSON.stringify({ secret })
        }).then(() => history.replaceState(null, '', `${location.pathname}${location.search}`))
      : request<Task[]>('/api/tasks')
    void pair
      .then(() => setState('ready'))
      .catch((error) => {
        const text = error instanceof Error ? error.message : 'Pairing failed.'
        setMessage(text)
        setState(text.includes('Pairing expired') ? 'expired' : 'error')
      })
  }, [])

  if (state === 'ready') return <>{children}</>
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-5 text-center">
        {state === 'pairing' ? (
          <LoaderCircleIcon className="mx-auto size-8 animate-spin text-muted-foreground" />
        ) : (
          <WifiOffIcon className="mx-auto size-8 text-muted-foreground" />
        )}
        <div>
          <h1 className="text-base font-semibold">
            {state === 'pairing' ? 'Connecting to DevTrees' : 'Scan the QR code again'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {state === 'pairing'
              ? 'Establishing a temporary local-network session.'
              : message || 'This pairing is no longer valid.'}
          </p>
        </div>
      </div>
    </main>
  )
}

function Dashboard({
  tasks,
  sessions,
  onOpenSession,
  onOpenTasks
}: {
  tasks: Task[]
  sessions: TerminalSession[]
  onOpenSession: (id: string) => void
  onOpenTasks: () => void
}): React.JSX.Element {
  const active = sessions.filter((session) => !['done', 'error'].includes(session.status))
  const attention = active.filter((session) => session.status === 'waiting-input')
  const queued = tasks.filter((task) => task.queueStatus === 'queued')
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <section>
        <h2 className="text-base font-semibold">Activity</h2>
        <p className="text-sm text-muted-foreground">Live work from the DevTrees host.</p>
      </section>
      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Active sessions</h3>
            <p className="text-xs text-muted-foreground">
              {active.length} running · {attention.length} need attention
            </p>
          </div>
          <BotIcon className="size-4 text-muted-foreground" />
        </div>
        {active.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No Copilot sessions are running.</p>
        ) : (
          <div className="divide-y">
            {active.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onOpenSession(session.id)}
                className="remote-touch flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <StatusDot status={session.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{session.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {session.pendingPrompt || session.lastActivity}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <button
        type="button"
        onClick={onOpenTasks}
        className="remote-touch flex items-center justify-between rounded-lg border bg-card px-4 py-3 text-left hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span>
          <span className="block text-sm font-semibold">Task queue</span>
          <span className="block text-xs text-muted-foreground">
            {tasks.length} tasks · {queued.length} queued
          </span>
        </span>
        <KanbanSquareIcon className="size-4 text-muted-foreground" />
      </button>
    </div>
  )
}

function Tasks({
  tasks,
  refresh
}: {
  tasks: Task[]
  refresh: () => Promise<void>
}): React.JSX.Element {
  const [status, setStatus] = React.useState<TaskStatus>('todo')
  const [creating, setCreating] = React.useState(false)
  const [editing, setEditing] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const shown = tasks
    .filter((task) => task.status === status)
    .sort((a, b) => a.sortOrder - b.sortOrder)
  const template = tasks[0]

  const mutate = async (key: string, operation: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await operation()
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const create = async (form: HTMLFormElement): Promise<void> => {
    const data = new FormData(form)
    await mutate('create', () =>
      request('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: String(data.get('title') ?? ''),
          description: String(data.get('description') ?? ''),
          repositoryId: String(data.get('repositoryId') ?? template?.repositoryId ?? ''),
          repositoryName: String(data.get('repositoryName') ?? template?.repositoryName ?? ''),
          repositoryPath: String(data.get('repositoryPath') ?? template?.repositoryPath ?? ''),
          worktreePath: String(data.get('worktreePath') ?? template?.worktreePath ?? ''),
          worktreeBranch: null,
          pendingWorktreeName: null
        })
      })
    )
    setCreating(false)
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {STATUSES.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setStatus(item)}
            className={`remote-touch shrink-0 rounded-md px-3 text-sm font-medium ${
              status === item
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {STATUS_LABEL[item]} {tasks.filter((task) => task.status === item).length}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCreating((value) => !value)}
          className="remote-touch ml-auto flex shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium"
        >
          <PlusIcon className="size-4" /> Add
        </button>
      </div>
      {creating ? (
        <form
          className="space-y-3 rounded-lg border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void create(event.currentTarget)
          }}
        >
          <input
            name="title"
            required
            placeholder="Task title"
            className="h-11 w-full rounded-md border bg-background px-3"
          />
          <textarea
            name="description"
            placeholder="Description"
            className="min-h-24 w-full rounded-md border bg-background p-3"
          />
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Repository and worktree
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <input
                name="repositoryName"
                required
                defaultValue={template?.repositoryName ?? ''}
                placeholder="Repository name"
                className="h-11 rounded-md border bg-background px-3"
              />
              <input
                name="repositoryId"
                required
                defaultValue={template?.repositoryId ?? ''}
                placeholder="Repository id"
                className="h-11 rounded-md border bg-background px-3"
              />
              <input
                name="repositoryPath"
                required
                defaultValue={template?.repositoryPath ?? ''}
                placeholder="Repository path"
                className="h-11 rounded-md border bg-background px-3 sm:col-span-2"
              />
              <input
                name="worktreePath"
                required
                defaultValue={template?.worktreePath ?? ''}
                placeholder="Worktree path"
                className="h-11 rounded-md border bg-background px-3 sm:col-span-2"
              />
            </div>
          </details>
          <button
            disabled={busy === 'create'}
            className="remote-touch w-full rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Create task
          </button>
        </form>
      ) : null}
      <div className="space-y-3">
        {shown.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No tasks in {STATUS_LABEL[status]}.
          </p>
        ) : (
          shown.map((task) => (
            <article key={task.id} className="rounded-lg border bg-card p-4">
              {editing === task.id ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const data = new FormData(event.currentTarget)
                    void mutate(task.id, () =>
                      request(`/api/tasks/${task.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({
                          title: String(data.get('title') ?? ''),
                          description: String(data.get('description') ?? ''),
                          repositoryId: task.repositoryId,
                          repositoryName: task.repositoryName,
                          repositoryPath: task.repositoryPath,
                          worktreePath: task.worktreePath,
                          worktreeBranch: task.worktreeBranch,
                          pendingWorktreeName: task.pendingWorktreeName
                        })
                      })
                    ).then(() => setEditing(null))
                  }}
                >
                  <input
                    name="title"
                    required
                    defaultValue={task.title}
                    className="h-11 w-full rounded-md border bg-background px-3"
                  />
                  <textarea
                    name="description"
                    defaultValue={task.description}
                    className="min-h-24 w-full rounded-md border bg-background p-3"
                  />
                  <div className="flex gap-2">
                    <button className="remote-touch rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="remote-touch rounded-md border px-4 text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold">{task.title}</h3>
                      {task.description ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                          {task.description}
                        </p>
                      ) : null}
                      <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
                        {task.repositoryName} · {task.worktreePath}
                      </p>
                    </div>
                    <button
                      aria-label={`Edit ${task.title}`}
                      onClick={() => setEditing(task.id)}
                      className="remote-touch flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                    >
                      <PencilIcon className="size-4" />
                    </button>
                    <button
                      aria-label={`Delete ${task.title}`}
                      disabled={busy === task.id}
                      onClick={() =>
                        void mutate(task.id, () =>
                          request(`/api/tasks/${task.id}`, { method: 'DELETE' })
                        )
                      }
                      className="remote-touch flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2Icon className="size-4" />
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <select
                      aria-label={`Move ${task.title}`}
                      value={task.status}
                      disabled={busy === task.id}
                      onChange={(event) =>
                        void mutate(task.id, () =>
                          request(`/api/tasks/${task.id}/move`, {
                            method: 'POST',
                            body: JSON.stringify({ status: event.target.value })
                          })
                        )
                      }
                      className="remote-touch rounded-md border bg-background px-3 text-sm"
                    >
                      {STATUSES.map((item) => (
                        <option key={item} value={item}>
                          {STATUS_LABEL[item]}
                        </option>
                      ))}
                    </select>
                    {task.status === 'todo' || task.status === 'review' ? (
                      <button
                        disabled={busy === task.id}
                        onClick={() =>
                          void mutate(task.id, () =>
                            request(`/api/tasks/${task.id}/start`, { method: 'POST', body: '{}' })
                          )
                        }
                        className="remote-touch flex items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
                      >
                        <PlayIcon className="size-4" /> Start
                      </button>
                    ) : null}
                  </div>
                </>
              )}
            </article>
          ))
        )}
      </div>
    </div>
  )
}

function renderEntry(entry: TerminalTimelineEntry): string {
  if (entry.kind === 'userMessage' || entry.kind === 'assistantMessage') return entry.text
  if (entry.kind === 'toolCall')
    return `${entry.name}: ${entry.detail}${entry.result ? `\n${entry.result}` : ''}`
  if (entry.kind === 'permission')
    return `${entry.description}${entry.resolution ? ` — ${entry.resolution}` : ''}`
  if (entry.kind === 'notice') return entry.text
  return JSON.stringify(entry.data)
}

function Interaction({
  interaction,
  respond
}: {
  interaction: NativeInteraction
  respond: (answer: NativeAnswer) => Promise<void>
}): React.JSX.Element {
  const [answer, setAnswer] = React.useState('')
  if (interaction.kind === 'acpPermission') {
    return (
      <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="text-sm font-medium">{interaction.message}</p>
        <div className="flex flex-wrap gap-2">
          {interaction.options.map((option) => (
            <button
              key={option.optionId}
              onClick={() => void respond({ kind: 'permission', action: option.optionId })}
              className="remote-touch rounded-md border bg-background px-3 text-sm"
            >
              {option.name}
            </button>
          ))}
        </div>
      </div>
    )
  }
  if (interaction.kind === 'elicitation') {
    return (
      <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="text-sm font-medium">{interaction.message}</p>
        {!interaction.url && interaction.schema ? (
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Response"
            className="min-h-20 w-full rounded-md border bg-background p-3"
          />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() =>
              void respond({
                kind: 'elicitation',
                action: 'accept',
                content: !interaction.url && answer ? { response: answer } : undefined
              })
            }
            className="remote-touch rounded-md bg-primary px-3 text-sm text-primary-foreground"
          >
            Accept
          </button>
          <button
            onClick={() => void respond({ kind: 'elicitation', action: 'decline' })}
            className="remote-touch rounded-md border bg-background px-3 text-sm"
          >
            Decline
          </button>
          <button
            onClick={() => void respond({ kind: 'elicitation', action: 'cancel' })}
            className="remote-touch rounded-md px-3 text-sm text-muted-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }
  if (interaction.kind === 'question') {
    return (
      <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="text-sm font-medium">{interaction.message}</p>
        <div className="flex flex-wrap gap-2">
          {interaction.choices.map((choice) => (
            <button
              key={choice}
              onClick={() => void respond({ kind: 'question', answer: choice, wasFreeform: false })}
              className="remote-touch rounded-md border bg-background px-3 text-sm"
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
              if (answer.trim())
                void respond({ kind: 'question', answer: answer.trim(), wasFreeform: true })
            }}
          >
            <input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              className="h-11 flex-1 rounded-md border bg-background px-3"
            />
            <button className="remote-touch rounded-md bg-primary px-3 text-sm text-primary-foreground">
              Send
            </button>
          </form>
        ) : null}
      </div>
    )
  }
  if (interaction.kind === 'plan') {
    return (
      <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="text-sm font-medium">{interaction.message}</p>
        {interaction.plan ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
            {interaction.plan}
          </pre>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {interaction.actions.map((selectedAction) => (
            <button
              key={selectedAction}
              onClick={() => void respond({ kind: 'plan', approved: true, selectedAction })}
              className="remote-touch rounded-md bg-primary px-3 text-sm text-primary-foreground"
            >
              {selectedAction}
            </button>
          ))}
          <button
            onClick={() => void respond({ kind: 'plan', approved: false })}
            className="remote-touch rounded-md border px-3 text-sm"
          >
            Reject
          </button>
        </div>
      </div>
    )
  }
  if (interaction.kind === 'autoMode') {
    return (
      <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="text-sm font-medium">{interaction.message}</p>
        <div className="flex gap-2">
          <button
            onClick={() => void respond({ kind: 'autoMode', approved: true })}
            className="remote-touch rounded-md bg-primary px-3 text-sm text-primary-foreground"
          >
            Approve
          </button>
          <button
            onClick={() => void respond({ kind: 'autoMode', approved: false })}
            className="remote-touch rounded-md border px-3 text-sm"
          >
            Reject
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="text-sm font-medium">{interaction.message}</p>
      <div className="flex gap-2">
        <button
          onClick={() => void respond({ kind: 'cancel' })}
          className="remote-touch rounded-md border bg-background px-3 text-sm"
        >
          Cancel request
        </button>
      </div>
    </div>
  )
}

function SessionDetail({
  session,
  onBack
}: {
  session: TerminalSession
  onBack: () => void
}): React.JSX.Element {
  const [snapshot, setSnapshot] = React.useState<NativeSnapshot | null>(null)
  const [history, setHistory] = React.useState<TerminalTimelineEntry[]>([])
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')
  const generation = session.generation

  const load = React.useCallback(async (): Promise<void> => {
    try {
      setError('')
      if (session.transport === 'external' || !generation) {
        setHistory(await request(`/api/sessions/${session.id}/history`))
        return
      }
      setSnapshot(
        await request(`/api/sessions/${session.id}/snapshot`, {
          method: 'POST',
          body: JSON.stringify({ generation })
        })
      )
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load session.')
    }
  }, [generation, session.id, session.transport])

  React.useEffect(() => {
    queueMicrotask(() => void load())
    const timer = window.setInterval(() => void load(), 1500)
    return () => window.clearInterval(timer)
  }, [load])

  const entries = snapshot?.entries ?? history
  const action = async (path: string, body: unknown): Promise<void> => {
    await request(`/api/sessions/${session.id}/${path}`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
    await load()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-3 py-2">
        <button
          onClick={onBack}
          className="remote-touch flex size-11 items-center justify-center rounded-md hover:bg-accent"
          aria-label="Back to sessions"
        >
          <ArrowLeftIcon className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{session.label}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {session.repository || session.folderPath}
          </p>
        </div>
        <StatusDot status={session.status} />
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {entries.map((entry) => (
          <div
            key={entry.seq}
            className={`max-w-3xl whitespace-pre-wrap break-words rounded-lg border p-3 text-sm ${entry.kind === 'userMessage' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-card'}`}
          >
            {renderEntry(entry)}
          </div>
        ))}
        {snapshot?.interactions.map((interaction) => (
          <Interaction
            key={interaction.id}
            interaction={interaction}
            respond={(answer) =>
              action('respond', { generation, interactionId: interaction.id, answer })
            }
          />
        ))}
        {snapshot?.planTransitionAvailable ? (
          <div className="flex flex-wrap gap-2 rounded-lg border bg-card p-3">
            {['interactive', 'autopilot', 'autopilot_fleet', 'exit_only'].map((choice) => (
              <button
                key={choice}
                onClick={() => void action('plan', { generation, action: choice })}
                className="remote-touch rounded-md border px-3 text-sm"
              >
                {choice.replaceAll('_', ' ')}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {session.transport !== 'external' &&
      generation &&
      !['done', 'error'].includes(session.status) ? (
        <div className="remote-safe-bottom space-y-2 border-t bg-background p-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const text = message.trim()
              if (!text) return
              setMessage('')
              void action('prompt', {
                generation,
                id: crypto.randomUUID(),
                prompt: [{ type: 'text', text }]
              })
            }}
          >
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Message Copilot"
              className="min-h-11 flex-1 resize-none rounded-md border bg-background px-3 py-2"
            />
            <button
              className="remote-touch flex size-11 items-center justify-center rounded-md bg-primary text-primary-foreground"
              aria-label="Send"
            >
              <SendIcon className="size-4" />
            </button>
          </form>
          <div className="flex gap-2">
            <button
              onClick={() => void action('cancel', { generation })}
              className="remote-touch flex items-center gap-2 rounded-md border px-3 text-sm"
            >
              <SquareIcon className="size-3.5" /> Stop turn
            </button>
            <button
              onClick={() => void action('end', { generation })}
              className="remote-touch rounded-md px-3 text-sm text-muted-foreground"
            >
              End session
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Sessions({
  sessions,
  selectedId,
  select
}: {
  sessions: TerminalSession[]
  selectedId: string | null
  select: (id: string | null) => void
}): React.JSX.Element {
  const selected = sessions.find((session) => session.id === selectedId)
  if (selected) return <SessionDetail session={selected} onBack={() => select(null)} />
  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      {sessions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <SquareTerminalIcon className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No Copilot sessions</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => select(session.id)}
              className="remote-touch flex w-full items-center gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-accent"
            >
              <StatusDot status={session.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{session.label}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {session.lastActivity}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AppContent(): React.JSX.Element {
  const [view, setView] = React.useState<View>('dashboard')
  const [tasks, setTasks] = React.useState<Task[]>([])
  const [sessions, setSessions] = React.useState<TerminalSession[]>([])
  const [selectedSession, setSelectedSession] = React.useState<string | null>(null)
  const [connected, setConnected] = React.useState(false)
  const [error, setError] = React.useState('')

  const refresh = React.useCallback(async (): Promise<void> => {
    const [nextTasks, nextSessions] = await Promise.all([
      request<Task[]>('/api/tasks'),
      request<TerminalSession[]>('/api/sessions')
    ])
    setTasks(nextTasks)
    setSessions(nextSessions)
  }, [])

  React.useEffect(() => {
    queueMicrotask(() => {
      void refresh().catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : 'Could not load DevTrees.')
      )
    })
    let socket: WebSocket | null = null
    let retry = 0
    let stopped = false
    const connect = (): void => {
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`
      )
      socket.onopen = () => {
        retry = 0
        setConnected(true)
        setError('')
      }
      socket.onmessage = (event) => {
        const payload = JSON.parse(String(event.data)) as SocketSnapshot
        if (payload.type === 'snapshot') {
          setTasks(payload.tasks)
          setSessions(payload.sessions)
        }
      }
      socket.onclose = () => {
        setConnected(false)
        if (!stopped) window.setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000))
      }
    }
    connect()
    return () => {
      stopped = true
      socket?.close()
    }
  }, [refresh])

  const openSession = (id: string): void => {
    setSelectedSession(id)
    setView('sessions')
  }

  const nav: { view: View; label: string; Icon: typeof GaugeIcon }[] = [
    { view: 'dashboard', label: 'Dashboard', Icon: GaugeIcon },
    { view: 'tasks', label: 'Tasks', Icon: KanbanSquareIcon },
    { view: 'sessions', label: 'Sessions', Icon: SquareTerminalIcon }
  ]

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">DevTrees</h1>
          <p className="text-xs text-muted-foreground">
            {nav.find((item) => item.view === view)?.label}
          </p>
        </div>
        <span
          className={`flex items-center gap-2 text-xs ${connected ? 'text-muted-foreground' : 'text-destructive'}`}
        >
          {connected ? (
            <span className="size-2 rounded-full bg-emerald-500" />
          ) : (
            <CircleAlertIcon className="size-3.5" />
          )}
          {connected ? 'Live' : 'Reconnecting'}
        </span>
        <button
          onClick={() => void refresh()}
          aria-label="Refresh"
          className="remote-touch flex size-11 items-center justify-center rounded-md hover:bg-accent"
        >
          <RefreshCwIcon className="size-4" />
        </button>
      </header>
      {error ? (
        <p className="border-b bg-destructive/5 px-4 py-2 text-sm text-destructive">{error}</p>
      ) : null}
      <main className="min-h-0 flex-1 overflow-y-auto">
        {view === 'dashboard' ? (
          <Dashboard
            tasks={tasks}
            sessions={sessions}
            onOpenSession={openSession}
            onOpenTasks={() => setView('tasks')}
          />
        ) : view === 'tasks' ? (
          <Tasks tasks={tasks} refresh={refresh} />
        ) : (
          <Sessions sessions={sessions} selectedId={selectedSession} select={setSelectedSession} />
        )}
      </main>
      {!selectedSession || view !== 'sessions' ? (
        <nav
          className="remote-safe-bottom grid shrink-0 grid-cols-3 border-t bg-background px-2 pt-2"
          aria-label="Primary"
        >
          {nav.map(({ view: item, label, Icon }) => (
            <button
              key={item}
              onClick={() => setView(item)}
              className={`remote-touch flex flex-col items-center justify-center gap-1 rounded-md text-xs font-medium ${view === item ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}
            >
              <Icon className="size-5" /> {label}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  )
}

export function RemoteApp(): React.JSX.Element {
  return (
    <PairingGate>
      <AppContent />
    </PairingGate>
  )
}
