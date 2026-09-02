import * as React from 'react'
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleStopIcon,
  FolderGit2Icon,
  GitBranchIcon,
  Loader2Icon,
  SendIcon,
  XIcon
} from 'lucide-react'

import { MarkdownBody } from '@/components/pr-review/markdown-body'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useChat } from '@/contexts/chat-context'
import { cn } from '@/lib/utils'
import type { Repository } from '@shared/repository'
import type { ChatContext } from '@shared/chat'
import type { Worktree } from '@shared/worktree'

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function ContextPicker({
  repositories,
  worktreesByRepositoryId,
  value,
  disabled,
  onChange
}: {
  repositories: Repository[]
  worktreesByRepositoryId: Record<string, Worktree[]>
  value?: ChatContext
  disabled: boolean
  onChange: (context?: ChatContext) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 max-w-64 gap-1.5 px-2" disabled={disabled}>
          {value?.kind === 'worktree' ? (
            <GitBranchIcon className="size-3.5" />
          ) : (
            <FolderGit2Icon className="size-3.5" />
          )}
          <span className="truncate">{value?.name ?? 'Add repository context'}</span>
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
        {value ? (
          <>
            <DropdownMenuItem onSelect={() => onChange(undefined)}>
              <XIcon />
              Clear context
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {repositories.length === 0 ? (
          <DropdownMenuItem disabled>No repositories available</DropdownMenuItem>
        ) : (
          repositories.flatMap((repository) => {
            const repositoryContext: ChatContext = {
              kind: 'repository',
              id: repository.id,
              name: repository.name,
              path: repository.path
            }
            const items: React.JSX.Element[] = [
              <DropdownMenuItem key={repository.id} onSelect={() => onChange(repositoryContext)}>
                <FolderGit2Icon />
                <span className="flex-1 truncate">{repository.name}</span>
                {value?.kind === 'repository' && value.id === repository.id ? (
                  <CheckIcon className="size-3.5" />
                ) : null}
              </DropdownMenuItem>
            ]
            for (const worktree of worktreesByRepositoryId[repository.id] ?? []) {
              const label = worktree.path.split(/[\\/]/).pop() || worktree.path
              items.push(
                <DropdownMenuItem
                  key={worktree.path}
                  className="pl-7"
                  onSelect={() =>
                    onChange({
                      kind: 'worktree',
                      id: `${repository.id}:${worktree.path}`,
                      name: `${repository.name} / ${label}`,
                      path: worktree.path
                    })
                  }
                >
                  <GitBranchIcon />
                  <span className="flex-1 truncate">{label}</span>
                  {value?.kind === 'worktree' && value.path === worktree.path ? (
                    <CheckIcon className="size-3.5" />
                  ) : null}
                </DropdownMenuItem>
              )
            }
            return items
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ChatPage({
  repositories,
  worktreesByRepositoryId
}: {
  repositories: Repository[]
  worktreesByRepositoryId: Record<string, Worktree[]>
}): React.JSX.Element {
  const { activeConversation, messages, sending, createConversation, updateContext, send, abort } =
    useChat()
  const [draft, setDraft] = React.useState('')
  const scrollRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages])

  const submit = React.useCallback((): void => {
    const prompt = draft.trim()
    if (!prompt || sending) return
    setDraft('')
    void send(prompt)
  }, [draft, sending, send])

  if (!activeConversation) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <BotIcon className="size-10 opacity-35" />
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">Ask Copilot</p>
          <p className="max-w-sm text-xs">
            Start a persistent conversation. Add repository context only when the question needs it.
          </p>
        </div>
        <Button onClick={() => void createConversation()}>New chat</Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b px-4">
        <ContextPicker
          repositories={repositories}
          worktreesByRepositoryId={worktreesByRepositoryId}
          value={activeConversation.context}
          disabled={sending}
          onChange={(context) => void updateContext(context)}
        />
        <span className="text-muted-foreground ml-auto text-[11px]">Read-only Q&amp;A</span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center text-xs">
            Ask a question to begin this conversation.
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-5">
            {messages.map((message) => (
              <article
                key={message.id}
                className={cn(
                  'border-b py-5 first:pt-0 last:border-b-0',
                  message.role === 'user' && 'bg-muted/35 -mx-3 rounded-md border-b-0 px-3'
                )}
              >
                <header className="mb-2 flex items-center gap-2">
                  <span className="text-xs font-semibold">
                    {message.role === 'user' ? 'You' : 'Copilot'}
                  </span>
                  <time className="text-muted-foreground text-[10px]">
                    {formatTime(message.createdAt)}
                  </time>
                </header>
                {message.role === 'assistant' ? (
                  message.content ? (
                    <MarkdownBody text={message.content} />
                  ) : message.status === 'streaming' ? (
                    <div className="text-muted-foreground flex items-center gap-2 text-xs">
                      <Loader2Icon className="size-3.5 animate-spin" />
                      Thinking…
                    </div>
                  ) : null
                ) : (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
                )}
                {message.status === 'streaming' && message.content ? (
                  <Loader2Icon className="text-muted-foreground mt-2 size-3 animate-spin" />
                ) : null}
                {message.status === 'error' ? (
                  <p className="text-destructive mt-2 text-xs">
                    {message.error ?? 'Copilot could not complete this response.'}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t bg-background p-4">
        <div className="focus-within:ring-ring/50 mx-auto flex max-w-3xl items-end gap-2 rounded-lg border bg-card p-2 shadow-xs focus-within:ring-3">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
            placeholder="Ask Copilot…"
            aria-label="Message Copilot"
            rows={1}
            disabled={sending}
            className="max-h-36 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          {sending ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 shrink-0"
              onClick={() => void abort()}
              aria-label="Stop response"
              title="Stop response"
            >
              <CircleStopIcon />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              className="size-9 shrink-0"
              disabled={!draft.trim()}
              onClick={submit}
              aria-label="Send message"
              title="Send message"
            >
              <SendIcon />
            </Button>
          )}
        </div>
        <p className="text-muted-foreground mx-auto mt-1.5 max-w-3xl text-center text-[10px]">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  )
}
