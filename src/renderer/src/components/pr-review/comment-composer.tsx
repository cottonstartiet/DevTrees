import * as React from 'react'
import { Loader2 as Loader2Icon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface CommentComposerProps {
  /** Where the comment will land, e.g. `README.md L12–L18 · preview`. */
  anchorLabel?: string
  placeholder?: string
  submitLabel?: string
  autoFocus?: boolean
  /** Resolves to an error message, or null on success. */
  onSubmit: (content: string) => Promise<string | null>
  onCancel: () => void
  className?: string
}

/**
 * Markdown comment box used for new threads and replies.
 *
 * On failure the draft is kept so a `gh`/`az` hiccup never costs the user their text.
 * Ctrl/Cmd+Enter submits; Escape cancels.
 */
export function CommentComposer({
  anchorLabel,
  placeholder = 'Leave a comment…',
  submitLabel = 'Comment',
  autoFocus = true,
  onSubmit,
  onCancel,
  className
}: CommentComposerProps): React.JSX.Element {
  const [content, setContent] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [isBusy, setIsBusy] = React.useState(false)

  const canSubmit = content.trim().length > 0 && !isBusy

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setIsBusy(true)
    setError(null)
    const message = await onSubmit(content)
    setIsBusy(false)
    if (message) {
      setError(message)
      return
    }
    setContent('')
  }

  return (
    <div className={cn('bg-card flex flex-col gap-2 rounded-md border p-2', className)}>
      {anchorLabel ? (
        <p className="text-muted-foreground font-mono text-[11px]">{anchorLabel}</p>
      ) : null}
      <textarea
        autoFocus={autoFocus}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
            return
          }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            void submit()
          }
        }}
        placeholder={placeholder}
        aria-label="Comment body (markdown)"
        rows={4}
        className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-h-20 w-full resize-y rounded-md border bg-transparent px-2 py-1.5 font-mono text-xs shadow-xs outline-none focus-visible:ring-[3px]"
      />
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button size="sm" className="h-7" onClick={() => void submit()} disabled={!canSubmit}>
          {isBusy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {submitLabel}
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={onCancel} disabled={isBusy}>
          Cancel
        </Button>
        <span className="text-muted-foreground ml-auto text-[10px]">Markdown · Ctrl+Enter</span>
      </div>
    </div>
  )
}
