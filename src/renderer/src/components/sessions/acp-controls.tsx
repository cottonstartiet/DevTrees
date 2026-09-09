import * as React from 'react'
import { PaperclipIcon, SendIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import {
  nativeKey,
  parsePromptAttachments,
  type PromptContent,
  type QueuedPrompt
} from '@shared/native-session'
import type { TerminalSession } from '@shared/terminal-session'

function QueueItem({ session, item }: { session: TerminalSession; item: QueuedPrompt }) {
  const { queueNative, nativeBusy } = useTerminalSessions()
  const [editing, setEditing] = React.useState(false)
  const text = item.text
  const [draft, setDraft] = React.useState(text)
  const inflight = item.status === 'dispatching' || item.status === 'active'
  const busy = nativeBusy[nativeKey(session, 'queue')]
  return (
    <li className="space-y-2 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{text || 'Attached context'}</span>
        <span className="text-muted-foreground text-xs">{item.status}</span>
        {item.attachmentCount > 0 && (
          <span className="text-muted-foreground text-xs">{item.attachmentCount} attachments</span>
        )}
      </div>
      {item.error && (
        <p role="alert" className="text-destructive text-xs">
          {item.error}
        </p>
      )}
      {editing && (
        <Textarea
          aria-label="Edit queued message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      {!inflight && (
        <div className="flex flex-wrap gap-2">
          {item.status === 'queued' && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (!editing) {
                    setEditing(true)
                    return
                  }
                  void queueNative(session, 'edit', item.id, draft).then((saved) => {
                    if (saved) setEditing(false)
                  })
                }}
              >
                {editing ? 'Save' : 'Edit'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void queueNative(session, 'up', item.id)}
              >
                Move earlier
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void queueNative(session, 'remove', item.id)}
          >
            Remove
          </Button>
        </div>
      )}
    </li>
  )
}

function fileContent(file: File): Promise<PromptContent> {
  if (file.size > 8 * 1024 * 1024)
    return Promise.reject(new Error('Each attachment must be smaller than 8 MiB.'))
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          reject(new Error('Could not encode this image.'))
          return
        }
        resolve({
          type: 'image',
          mimeType: file.type,
          data: reader.result.slice(reader.result.indexOf(',') + 1)
        })
      }
      reader.readAsDataURL(file)
    })
  }
  return file.arrayBuffer().then((bytes) => {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error(`${file.name} is not valid UTF-8 text. Convert it before attaching it.`)
    }
    if (text.includes('\0')) throw new Error(`${file.name} is not a supported text file.`)
    return {
      type: 'resource',
      resource: {
        uri: `devtrees-attachment:${encodeURIComponent(file.name)}`,
        mimeType: 'text/plain',
        text
      }
    }
  })
}

export function AcpComposer({ session, compact }: { session: TerminalSession; compact: boolean }) {
  const { nativeById, nativeDrafts, setNativeDraft, nativeBusy, promptNative, queueNative } =
    useTerminalSessions()
  const snapshot = nativeById[session.id]
  const key = nativeKey(session)
  const draft = nativeDrafts[key] ?? {}
  const message = String(draft.message ?? '')
  const [error, setError] = React.useState<string | null>(null)
  const [attaching, setAttaching] = React.useState(false)
  const [commandSearch, setCommandSearch] = React.useState('')
  const [commandsOpen, setCommandsOpen] = React.useState(false)
  const literal = draft.literal === true
  const setLiteral = (value: boolean): void =>
    setNativeDraft(key, (current) => ({ ...current, literal: value }))
  const input = React.useRef<HTMLInputElement>(null)
  const launch = useCopilotLauncher()
  const [saved, setSaved] = React.useState<Awaited<
    ReturnType<typeof window.api.nativeSessions.listSaved>
  > | null>(null)
  const [listing, setListing] = React.useState(false)
  const composer = React.useRef<HTMLTextAreaElement>(null)
  const parsed = React.useMemo(
    () => parsePromptAttachments(String(draft.attachments ?? '[]')),
    [draft.attachments]
  )
  const attachments = parsed.content
  const phase = snapshot?.phase
  const canSubmit = Boolean(
    snapshot && !['starting', 'loading', 'ending', 'ended', 'failed'].includes(phase ?? 'starting')
  )
  const queue = snapshot?.queue ?? []
  const pending = queue.filter((item) => !['completed', 'cancelled'].includes(item.status))
  const commands = (snapshot?.commands ?? []).filter((command) =>
    `${command.name} ${command.description}`.toLowerCase().includes(commandSearch.toLowerCase())
  )
  const send = async (): Promise<void> => {
    if (
      !canSubmit ||
      attaching ||
      parsed.error ||
      draft.attachmentError ||
      (!message.trim() && attachments.length === 0)
    )
      return
    setError(null)
    await promptNative(session, message, true, attachments, literal)
  }
  return (
    <div className="space-y-3">
      {!compact && (
        <div className="flex flex-wrap items-center gap-2">
          {snapshot?.capabilities?.sessionCapabilities?.list && (
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost">
                  Saved conversations
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="max-h-96 w-96 max-w-[90vw] space-y-2 overflow-auto"
              >
                <p className="text-muted-foreground text-xs">
                  Loaded from Copilot. A conversation must be ended before it can be resumed
                  elsewhere.
                </p>
                {saved?.sessions.map((item) => (
                  <Button
                    key={item.sessionId}
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start truncate"
                    onClick={() => {
                      void launch({
                        folderPath: item.cwd,
                        resumeSessionId: item.sessionId,
                        label: item.title || 'Copilot conversation'
                      })
                        .then((result) => {
                          if (!result.ok) setError(result.error)
                        })
                        .catch((e) => setError(String(e)))
                    }}
                  >
                    {item.title || item.sessionId}
                  </Button>
                ))}
                {(!saved || saved.nextCursor) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={listing || !session.generation}
                    onClick={() => {
                      if (!session.generation) return
                      setListing(true)
                      void window.api.nativeSessions
                        .listSaved(
                          { id: session.id, generation: session.generation },
                          saved?.nextCursor
                        )
                        .then((result) =>
                          setSaved((previous) => ({
                            ...result,
                            sessions: [
                              ...new Map(
                                [...(previous?.sessions ?? []), ...result.sessions].map((item) => [
                                  item.sessionId,
                                  item
                                ])
                              ).values()
                            ]
                          }))
                        )
                        .catch((e) => setError(String(e)))
                        .finally(() => setListing(false))
                    }}
                  >
                    {listing ? 'Loading...' : saved ? 'Load more' : 'Load conversations'}
                  </Button>
                )}
              </PopoverContent>
            </Popover>
          )}
          {snapshot?.usage && (
            <span className="text-muted-foreground text-xs">
              Context: {snapshot.usage.used.toLocaleString()} /{' '}
              {snapshot.usage.size.toLocaleString()} tokens
              {snapshot.usage.cost && (
                <>
                  {' '}
                  - {snapshot.usage.cost.amount.toLocaleString()} {snapshot.usage.cost.currency}
                </>
              )}
            </span>
          )}
        </div>
      )}
      {queue.length > 0 && (
        <details open={snapshot?.queuePaused || undefined}>
          <summary className="cursor-pointer text-xs">
            {pending.length} queued/incomplete messages{snapshot?.queuePaused ? ' - paused' : ''}
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={nativeBusy[nativeKey(session, 'queue')]}
              onClick={() => void queueNative(session, snapshot?.queuePaused ? 'resume' : 'pause')}
            >
              {snapshot?.queuePaused ? 'Resume queue' : 'Pause queue'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void queueNative(session, 'clear')}>
              Clear non-running items
            </Button>
          </div>
          <ul className="max-h-52 divide-y overflow-auto">
            {queue.map((item) => (
              <QueueItem key={item.id} session={session} item={item} />
            ))}
          </ul>
        </details>
      )}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        {(error || parsed.error || draft.attachmentError) && (
          <p role="alert" className="text-destructive text-sm">
            {error || parsed.error || String(draft.attachmentError)}
          </p>
        )}
        {(parsed.error || draft.attachmentError) && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              setNativeDraft(key, (current) => ({
                ...current,
                attachments: '[]',
                attachmentError: ''
              }))
            }
          >
            Clear invalid attachment draft
          </Button>
        )}
        <Textarea
          ref={composer}
          aria-label="Message Copilot"
          rows={compact ? 2 : 3}
          placeholder={
            phase === 'idle'
              ? 'Message Copilot or choose a /command...'
              : 'Queue your next instruction...'
          }
          value={message}
          onChange={(event) => {
            const message = event.target.value
            setNativeDraft(key, (current) => ({ ...current, message }))
          }}
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key === 'Enter' &&
              canSubmit &&
              !nativeBusy[key]
            ) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {attachments.map((block, index) => (
          <div className="flex items-center gap-2 text-xs" key={index}>
            <span className="min-w-0 flex-1 truncate">
              {block.type === 'image'
                ? `Image ${index + 1}`
                : block.type === 'resource'
                  ? block.resource.uri.replace('devtrees-attachment:', '')
                  : 'Context'}
            </span>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              aria-label={`Remove attachment ${index + 1}`}
              onClick={() =>
                setNativeDraft(key, {
                  ...draft,
                  attachments: JSON.stringify(attachments.filter((_, i) => i !== index))
                })
              }
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Popover open={commandsOpen} onOpenChange={setCommandsOpen}>
            <PopoverTrigger asChild>
              <Button type="button" size="sm" variant="ghost" disabled={!snapshot?.commandsReady}>
                / Commands
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-96 max-w-[90vw] p-2">
              <input
                className="border-input mb-2 w-full rounded border p-2 text-sm"
                aria-label="Find a Copilot command"
                value={commandSearch}
                onChange={(event) => setCommandSearch(event.target.value)}
              />
              <div className="max-h-64 overflow-y-auto">
                {commands.map((command) => (
                  <button
                    type="button"
                    key={command.name}
                    className="hover:bg-accent focus-visible:ring-ring block w-full rounded p-2 text-left focus-visible:ring-3"
                    onClick={() => {
                      setNativeDraft(key, {
                        ...draft,
                        message: `/${command.name}${command.input?.hint ? ' ' : ''}`
                      })
                      setLiteral(false)
                      setCommandsOpen(false)
                      setTimeout(() => composer.current?.focus(), 0)
                    }}
                  >
                    <span className="block text-sm font-medium">
                      /{command.name}{' '}
                      <span className="font-normal text-muted-foreground">
                        {command.input?.hint}
                      </span>
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {command.description}
                    </span>
                  </button>
                ))}
                {commands.length === 0 && <p className="p-2 text-sm">No matching commands.</p>}
              </div>
            </PopoverContent>
          </Popover>
          <input
            ref={input}
            type="file"
            className="hidden"
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              if (
                files.length > 32 ||
                files.reduce((size, file) => size + file.size, 0) > 16 * 1024 * 1024
              ) {
                setError('Select at most 32 files and 16 MiB per attachment batch.')
                event.target.value = ''
                return
              }
              setAttaching(true)
              setError(null)
              void Promise.all(files.map(fileContent))
                .then((blocks) => {
                  setNativeDraft(key, (current) => {
                    const previous = parsePromptAttachments(String(current.attachments ?? '[]'))
                    if (previous.error) return { ...current, attachmentError: previous.error }
                    return {
                      ...current,
                      attachments: JSON.stringify([...previous.content, ...blocks]),
                      attachmentError: ''
                    }
                  })
                })
                .catch((e) => setError(String(e)))
                .finally(() => {
                  setAttaching(false)
                  if (input.current) input.current.value = ''
                })
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={attaching || !canSubmit}
            onClick={() => input.current?.click()}
          >
            <PaperclipIcon className="size-3.5" />
            {attaching ? 'Reading...' : 'Attach'}
          </Button>
          <Button
            type="submit"
            size="sm"
            className="ml-auto"
            disabled={
              !canSubmit ||
              nativeBusy[key] ||
              attaching ||
              Boolean(parsed.error || draft.attachmentError) ||
              (!message.trim() && attachments.length === 0)
            }
          >
            <SendIcon className="size-3.5" />
            {nativeBusy[key]
              ? 'Saving...'
              : phase === 'idle' && !snapshot?.queuePaused
                ? 'Send'
                : 'Queue'}
          </Button>
        </div>
        {message.trimStart().startsWith('/') && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={literal}
              onChange={(event) => setLiteral(event.target.checked)}
            />
            Send as literal message instead of executing a command
          </label>
        )}
        <p className="text-muted-foreground text-xs">
          Ctrl+Enter to submit. Stop pauses the queue; reopening never sends saved items
          automatically.
        </p>
      </form>
    </div>
  )
}
