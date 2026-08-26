import * as React from 'react'
import {
  Check as CheckIcon,
  ChevronUp as ChevronUpIcon,
  ExternalLink as ExternalLinkIcon,
  RotateCcw as RotateCcwIcon
} from 'lucide-react'

import { CommentComposer } from '@/components/pr-review/comment-composer'
import { MarkdownBody } from '@/components/pr-review/markdown-body'
import { Button } from '@/components/ui/button'
import { openExternal } from '@/lib/system'
import { cn } from '@/lib/utils'
import type { RepoPrThread } from '@shared/reviews'

export interface ThreadCardProps {
  thread: RepoPrThread
  onReply: (thread: RepoPrThread, content: string) => Promise<string | null>
  onToggleResolved: (thread: RepoPrThread, resolved: boolean) => Promise<string | null>
  /** Start collapsed to a one-line summary. Resolved threads use this to stay out of the way. */
  defaultCollapsed?: boolean
  className?: string
}

/**
 * One existing review thread with its replies, rendered inline in the diff and preview panes.
 */
export function ThreadCard({
  thread,
  onReply,
  onToggleResolved,
  defaultCollapsed = false,
  className
}: ThreadCardProps): React.JSX.Element {
  const [isReplying, setIsReplying] = React.useState(false)
  const [isToggling, setIsToggling] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [isCollapsed, setIsCollapsed] = React.useState(defaultCollapsed)

  const toggleResolved = async (): Promise<void> => {
    setIsToggling(true)
    setError(null)
    const message = await onToggleResolved(thread, !thread.isResolved)
    setIsToggling(false)
    if (message) setError(message)
  }

  const firstComment = thread.comments[0]
  const replyCount = Math.max(0, thread.comments.length - 1)

  if (isCollapsed) {
    return (
      <button
        type="button"
        onClick={() => setIsCollapsed(false)}
        className={cn(
          'bg-card hover:bg-accent flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-xs transition-colors',
          className
        )}
      >
        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
          {thread.isResolved ? 'Resolved' : 'Active'}
        </span>
        <span className="shrink-0 text-[11px] font-medium">
          {firstComment?.author.displayName ?? 'Unknown'}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">
          {firstComment?.content.replace(/\s+/g, ' ').trim() || '(no content)'}
        </span>
        {replyCount > 0 ? (
          <span className="text-muted-foreground shrink-0 text-[10px]">
            {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <div className={cn('bg-card flex flex-col gap-2 rounded-md border p-2 text-xs', className)}>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
            thread.isResolved ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-foreground'
          )}
        >
          {thread.isResolved ? 'Resolved' : 'Active'}
        </span>
        {thread.lineNumber ? (
          <span className="text-muted-foreground font-mono text-[10px]">
            L{thread.lineNumber}
            {thread.endLineNumber && thread.endLineNumber > thread.lineNumber
              ? `\u2013L${thread.endLineNumber}`
              : ''}
          </span>
        ) : null}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => void toggleResolved()}
          disabled={isToggling}
          aria-label={thread.isResolved ? 'Reopen thread' : 'Resolve thread'}
          title={thread.isResolved ? 'Reopen thread' : 'Resolve thread'}
        >
          {thread.isResolved ? (
            <RotateCcwIcon className="size-3" />
          ) : (
            <CheckIcon className="size-3" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => void openExternal(thread.webUrl)}
          aria-label="Open thread in browser"
          title="Open thread in browser"
        >
          <ExternalLinkIcon className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setIsCollapsed(true)}
          aria-label="Collapse thread"
          title="Collapse thread"
        >
          <ChevronUpIcon className="size-3" />
        </Button>
      </div>

      <ul className="flex flex-col gap-2">
        {thread.comments.map((comment) => (
          <li key={comment.id} className="flex flex-col gap-0.5">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] font-medium">{comment.author.displayName}</span>
              {comment.publishedDate ? (
                <span className="text-muted-foreground text-[10px]" title={comment.publishedDate}>
                  {new Date(comment.publishedDate).toLocaleString()}
                </span>
              ) : null}
            </div>
            <MarkdownBody text={comment.content || '_(no content)_'} />
          </li>
        ))}
      </ul>

      {error ? <p className="text-destructive text-[11px]">{error}</p> : null}

      {isReplying ? (
        <CommentComposer
          submitLabel="Reply"
          placeholder="Reply…"
          onSubmit={async (content) => {
            const message = await onReply(thread, content)
            if (!message) setIsReplying(false)
            return message
          }}
          onCancel={() => setIsReplying(false)}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-fit px-2 text-[11px]"
          onClick={() => setIsReplying(true)}
        >
          Reply
        </Button>
      )}
    </div>
  )
}
