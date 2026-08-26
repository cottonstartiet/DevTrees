import * as React from 'react'
import { MessageSquarePlus as MessageSquarePlusIcon } from 'lucide-react'

import { CommentComposer } from '@/components/pr-review/comment-composer'
import { MermaidDiagram } from '@/components/pr-review/mermaid-diagram'
import { ThreadCard } from '@/components/pr-review/thread-card'
import {
  blockIndexForLine,
  renderMarkdownBlocks,
  selectionSourceRange,
  sourceRangeOf,
  type MarkdownBlock
} from '@/lib/markdown'
import { openExternal } from '@/lib/system'
import { cn } from '@/lib/utils'
import type { PrCommentAnchor } from '@shared/pr-review'
import type { RepoPrThread } from '@shared/reviews'

export interface MarkdownPreviewProps {
  path: string
  /** Head-side raw markdown. */
  text: string
  threads: RepoPrThread[]
  onCreateThread: (anchor: PrCommentAnchor, content: string) => Promise<string | null>
  onReply: (thread: RepoPrThread, content: string) => Promise<string | null>
  onToggleResolved: (thread: RepoPrThread, resolved: boolean) => Promise<string | null>
}

type Range = { startLine: number; endLine: number }

/** `docs/arch.md L12–L18` — the raw lines a block covers. */
function rangeLabel(path: string, range: Range): string {
  const lines =
    range.endLine > range.startLine
      ? `L${range.startLine}\u2013L${range.endLine}`
      : `L${range.startLine}`
  return `${path} ${lines}`
}

/** The same label, marked as having been chosen from the preview rather than the diff. */
function anchorLabel(path: string, range: Range): string {
  return `${rangeLabel(path, range)} · preview`
}

/**
 * Rendered markdown you can read and comment on in place.
 *
 * The document is rendered block by block rather than as one HTML string, so existing threads and
 * the composer appear directly beneath the block they belong to — the same inline model the diff
 * view uses. Every block carries the raw line range it came from, so a comment made here is posted
 * as an ordinary file + line-range comment; the preview is only how the range was chosen.
 */
export function MarkdownPreview({
  path,
  text,
  threads,
  onCreateThread,
  onReply,
  onToggleResolved
}: MarkdownPreviewProps): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [range, setRange] = React.useState<Range | null>(null)

  const blocks = React.useMemo(() => renderMarkdownBlocks(text), [text])

  // Threads land under the block containing their first line; `blockIndexForLine` falls back to
  // the nearest preceding block so a drifted comment is never silently dropped. Anything that
  // matches no block at all (no line, or a line before the first block) is listed separately.
  const { byBlock, unanchored } = React.useMemo(() => {
    const map = new Map<number, RepoPrThread[]>()
    const orphans: RepoPrThread[] = []

    for (const thread of threads) {
      const line = thread.lineNumber
      const index = line ? blockIndexForLine(blocks, line) : -1
      if (index < 0) {
        orphans.push(thread)
        continue
      }
      const list = map.get(index) ?? []
      list.push(thread)
      map.set(index, list)
    }

    for (const list of map.values()) {
      list.sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0))
    }
    return { byBlock: map, unanchored: orphans }
  }, [threads, blocks])

  const composerIndex = React.useMemo(
    () => (range ? blockIndexForLine(blocks, range.startLine) : -1),
    [range, blocks]
  )

  const handleInteraction = (event: React.MouseEvent<HTMLDivElement>): void => {
    const root = containerRef.current
    if (!root) return

    const anchorEl = (event.target as HTMLElement).closest('a')
    const href = anchorEl?.getAttribute('href')
    if (href) {
      event.preventDefault()
      if (/^https?:\/\//i.test(href)) void openExternal(href)
      return
    }

    // Clicks inside a thread card, the composer, or a diagram's own controls must not re-anchor
    // the range.
    if ((event.target as HTMLElement).closest('.md-thread-rail, .md-mermaid-toolbar')) return

    const selected = selectionSourceRange(window.getSelection(), root)
    if (selected) {
      setRange(selected)
      return
    }

    const block = sourceRangeOf(event.target as Element, root)
    if (block) setRange(block)
  }

  const renderComposer = (anchor: Range): React.JSX.Element => (
    <CommentComposer
      anchorLabel={anchorLabel(path, anchor)}
      onSubmit={async (content) => {
        const message = await onCreateThread(
          {
            filePath: path,
            side: 'right',
            startLine: anchor.startLine,
            endLine: anchor.endLine,
            origin: 'preview'
          },
          content
        )
        if (!message) setRange(null)
        return message
      }}
      onCancel={() => setRange(null)}
    />
  )

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-auto" onMouseUp={handleInteraction}>
      <div className="markdown-preview mx-auto flex max-w-4xl flex-col px-12 py-6">
        {blocks.length === 0 ? (
          <p className="text-muted-foreground text-xs italic">This file is empty.</p>
        ) : null}

        {blocks.map((block, index) => (
          <PreviewBlock
            key={block.key}
            block={block}
            path={path}
            isActive={
              range !== null && block.endLine >= range.startLine && block.startLine <= range.endLine
            }
            onComment={() => setRange({ startLine: block.startLine, endLine: block.endLine })}
          >
            {(byBlock.get(index) ?? []).map((thread) => (
              <ThreadCard
                key={thread.providerThreadId || thread.id}
                thread={thread}
                onReply={onReply}
                onToggleResolved={onToggleResolved}
                defaultCollapsed={thread.isResolved}
              />
            ))}
            {composerIndex === index && range ? renderComposer(range) : null}
          </PreviewBlock>
        ))}

        {/* A range resolving to no block (empty document) still needs somewhere to compose. */}
        {range && composerIndex < 0 ? (
          <div className="md-thread-rail mt-3">{renderComposer(range)}</div>
        ) : null}

        {unanchored.length > 0 ? (
          <section className="md-thread-rail mt-8 flex flex-col gap-2 border-t pt-4">
            <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              Comments not anchored to a block
            </h2>
            {unanchored.map((thread) => (
              <ThreadCard
                key={thread.providerThreadId || thread.id}
                thread={thread}
                onReply={onReply}
                onToggleResolved={onToggleResolved}
                defaultCollapsed={thread.isResolved}
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One rendered block plus anything anchored to it.
 *
 * The block's HTML is injected on its own wrapper so React keeps ownership of everything around
 * it — that is what makes inline threads possible.
 */
function PreviewBlock({
  block,
  path,
  isActive,
  onComment,
  children
}: {
  block: MarkdownBlock
  path: string
  isActive: boolean
  onComment: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const hasChildren = React.Children.toArray(children).length > 0

  return (
    <div className="md-block group relative">
      <button
        type="button"
        onClick={onComment}
        className={cn(
          'md-block-comment text-muted-foreground hover:text-foreground hover:bg-accent bg-background',
          'absolute top-1 -left-9 size-6 place-items-center rounded border opacity-0',
          'group-hover:opacity-100 focus-visible:opacity-100'
        )}
        aria-label={`Comment on lines ${block.startLine} to ${block.endLine}`}
        title={`Comment on L${block.startLine}\u2013L${block.endLine}`}
      >
        <MessageSquarePlusIcon className="size-3.5" />
      </button>

      <div
        className="markdown-body md-block-content"
        data-src-start={block.startLine}
        data-src-end={block.endLine}
        data-active={isActive ? 'true' : 'false'}
        {...(block.kind === 'html'
          ? { dangerouslySetInnerHTML: { __html: block.html } }
          : {
              children: (
                <MermaidDiagram
                  code={block.code}
                  info={block.info}
                  label={rangeLabel(path, block)}
                />
              )
            })}
      />

      {hasChildren ? (
        <div className="md-thread-rail mt-1 mb-3 flex flex-col gap-2">{children}</div>
      ) : null}
    </div>
  )
}
