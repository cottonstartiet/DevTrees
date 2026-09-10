import * as React from 'react'
import { PaperclipIcon, SendIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import {
  acpCommandDraft,
  acpCommandQuery,
  matchingAcpCommands,
  nativeKey,
  parsePromptAttachments,
  type PromptContent
} from '@shared/native-session'
import type { TerminalSession } from '@shared/terminal-session'

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

export function AcpComposer({
  session,
  compact,
  context = 'default',
  disabled = false
}: {
  session: TerminalSession
  compact: boolean
  context?: 'default' | 'plan-followup'
  disabled?: boolean
}) {
  const { nativeById, nativeDrafts, setNativeDraft, nativeBusy, promptNative } =
    useTerminalSessions()
  const snapshot = nativeById[session.id]
  const key = nativeKey(session)
  const draft = nativeDrafts[key] ?? {}
  const message = String(draft.message ?? '')
  const [error, setError] = React.useState<string | null>(null)
  const [attaching, setAttaching] = React.useState(false)
  const [commandSelection, setCommandSelection] = React.useState(0)
  const [commandsDismissed, setCommandsDismissed] = React.useState(false)
  const literal = draft.literal === true
  const setLiteral = (value: boolean): void =>
    setNativeDraft(key, (current) => ({ ...current, literal: value }))
  const input = React.useRef<HTMLInputElement>(null)
  const composer = React.useRef<HTMLTextAreaElement>(null)
  const parsed = React.useMemo(
    () => parsePromptAttachments(String(draft.attachments ?? '[]')),
    [draft.attachments]
  )
  const attachments = parsed.content
  const phase = snapshot?.phase
  const canSubmit = Boolean(
    !disabled &&
    snapshot &&
    !['starting', 'loading', 'ending', 'ended', 'failed'].includes(phase ?? 'starting')
  )
  const commandQuery = acpCommandQuery(message)
  const commands = React.useMemo(
    () => matchingAcpCommands(message, snapshot?.commands ?? []),
    [message, snapshot?.commands]
  )
  const commandsOpen = Boolean(
    canSubmit && snapshot?.commandsReady && commandQuery !== null && !commandsDismissed
  )
  const commandListId = React.useId()
  const selectedCommandIndex =
    commands.length > 0 ? Math.min(commandSelection, commands.length - 1) : 0
  const selectCommand = (command: (typeof commands)[number]): void => {
    setNativeDraft(key, (current) => ({
      ...current,
      message: acpCommandDraft(command),
      literal: false
    }))
    setCommandsDismissed(true)
    setCommandSelection(0)
    setTimeout(() => composer.current?.focus(), 0)
  }
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
        <Popover
          open={commandsOpen}
          onOpenChange={(open) => {
            if (!open) setCommandsDismissed(true)
          }}
        >
          <PopoverAnchor asChild>
            <Textarea
              ref={composer}
              role="combobox"
              aria-label={context === 'plan-followup' ? 'Reply about the plan' : 'Message Copilot'}
              aria-autocomplete="list"
              aria-controls={commandsOpen ? commandListId : undefined}
              aria-expanded={commandsOpen}
              aria-activedescendant={
                commandsOpen && commands.length > 0
                  ? `${commandListId}-${selectedCommandIndex}`
                  : undefined
              }
              rows={compact ? 2 : 3}
              placeholder={compact ? undefined : 'Ctrl+Enter to submit.'}
              disabled={disabled}
              value={message}
              onChange={(event) => {
                const message = event.target.value
                setCommandSelection(0)
                setCommandsDismissed(false)
                setNativeDraft(key, (current) => ({ ...current, message }))
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (
                  (event.ctrlKey || event.metaKey) &&
                  event.key === 'Enter' &&
                  canSubmit &&
                  !nativeBusy[key]
                ) {
                  event.preventDefault()
                  void send()
                  return
                }
                if (!commandsOpen) return
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setCommandsDismissed(true)
                  return
                }
                if (commands.length === 0) return
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setCommandSelection((current) => (current + 1) % commands.length)
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setCommandSelection(
                    (current) => (current - 1 + commands.length) % commands.length
                  )
                  return
                }
                if (
                  (event.key === 'Enter' && !event.shiftKey && !event.altKey) ||
                  event.key === 'Tab'
                ) {
                  event.preventDefault()
                  selectCommand(commands[selectedCommandIndex])
                }
              }}
            />
          </PopoverAnchor>
          <PopoverContent
            align="start"
            className="w-96 max-w-[calc(100vw-2rem)] p-2"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <div id={commandListId} role="listbox" aria-label="Copilot commands">
              <div className="max-h-64 overflow-y-auto">
                {commands.map((command, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedCommandIndex}
                    id={`${commandListId}-${index}`}
                    key={command.name}
                    className="hover:bg-accent focus-visible:ring-ring aria-selected:bg-accent block w-full rounded p-2 text-left focus-visible:ring-3 focus-visible:outline-none"
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setCommandSelection(index)}
                    onClick={() => selectCommand(command)}
                  >
                    <span className="block text-sm font-medium">
                      /{command.name}{' '}
                      <span className="text-muted-foreground font-normal">
                        {command.input?.hint}
                      </span>
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {command.description}
                    </span>
                  </button>
                ))}
                {commands.length === 0 && (
                  <p className="text-muted-foreground p-2 text-sm">No matching commands.</p>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>
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
              disabled={disabled}
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
              : context === 'plan-followup'
                ? 'Send reply'
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
              disabled={disabled}
              onChange={(event) => setLiteral(event.target.checked)}
            />
            Send as literal message instead of executing a command
          </label>
        )}
      </form>
    </div>
  )
}
