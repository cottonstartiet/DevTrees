import * as React from 'react'
import { ChevronsUpDown as ChevronsUpDownIcon, Plus as PlusIcon } from 'lucide-react'

import { CommentComposer } from '@/components/pr-review/comment-composer'
import { ThreadCard } from '@/components/pr-review/thread-card'
import { useSyntaxHighlight, type HighlightedLine } from '@/hooks/use-syntax-highlight'
import { cn } from '@/lib/utils'
import type { PrCommentAnchor, PrDiffLine, PrFileDiff } from '@shared/pr-review'
import type { RepoPrThread } from '@shared/reviews'

/** Lines of extra context revealed per click on an expander. */
const EXPAND_STEP = 20

export interface DiffViewProps {
  path: string
  diff: PrFileDiff | null
  error: string | null
  isLoading: boolean
  /** Threads anchored to this file. */
  threads?: RepoPrThread[]
  /** Full head-side text, used to reveal context between hunks. Optional. */
  headText: string | null
  onCreateThread?: (anchor: PrCommentAnchor, content: string) => Promise<string | null>
  onReply?: (thread: RepoPrThread, content: string) => Promise<string | null>
  onToggleResolved?: (thread: RepoPrThread, resolved: boolean) => Promise<string | null>
  truncatedMessage?: string
}

type Row =
  | { kind: 'expand'; key: string; from: number; to: number }
  | { kind: 'line'; key: string; line: PrDiffLine }

/**
 * Unified diff for one file: gutter line numbers, hover-to-comment, click-drag for a multi-line
 * anchor, expandable context between hunks, and inline threads at their anchored line.
 */
export function DiffView({
  path,
  diff,
  error,
  isLoading,
  threads = [],
  headText,
  onCreateThread,
  onReply,
  onToggleResolved,
  truncatedMessage = 'Diff truncated — open the PR in the browser for the full change.'
}: DiffViewProps): React.JSX.Element {
  const canComment = Boolean(onCreateThread && onReply && onToggleResolved)
  const [expanded, setExpanded] = React.useState<Map<string, number>>(new Map())
  const [drag, setDrag] = React.useState<{ start: number; end: number } | null>(null)
  const [isDragging, setIsDragging] = React.useState(false)
  const [anchor, setAnchor] = React.useState<{ start: number; end: number } | null>(null)

  React.useEffect(() => {
    if (!isDragging) return
    const finish = (): void => {
      setIsDragging(false)
      setDrag((current) => {
        if (current) {
          setAnchor({
            start: Math.min(current.start, current.end),
            end: Math.max(current.start, current.end)
          })
        }
        return null
      })
    }
    window.addEventListener('mouseup', finish)
    return () => window.removeEventListener('mouseup', finish)
  }, [isDragging])

  const headLines = React.useMemo(() => (headText ? headText.split('\n') : null), [headText])

  const rows = React.useMemo<Row[]>(() => {
    if (!diff) return []
    const out: Row[] = []
    let previousHeadEnd = 0

    diff.hunks.forEach((hunk, hunkIndex) => {
      const gapEnd = hunk.headStart - 1
      if (headLines && gapEnd > previousHeadEnd) {
        const key = `gap-${hunkIndex}`
        const revealed = expanded.get(key) ?? 0
        const from = Math.max(previousHeadEnd + 1, gapEnd - revealed + 1)
        if (from > previousHeadEnd + 1) {
          out.push({ kind: 'expand', key, from: previousHeadEnd + 1, to: gapEnd })
        }
        for (let line = from; line <= gapEnd; line++) {
          out.push({
            kind: 'line',
            key: `ctx-${line}`,
            line: {
              kind: 'context',
              baseLine: null,
              headLine: line,
              text: headLines[line - 1] ?? ''
            }
          })
        }
      } else if (!headLines) {
        out.push({ kind: 'expand', key: `header-${hunkIndex}`, from: 0, to: 0 })
      }

      hunk.lines.forEach((line, lineIndex) => {
        out.push({ kind: 'line', key: `h${hunkIndex}-${lineIndex}`, line })
      })
      previousHeadEnd = Math.max(previousHeadEnd, hunk.headStart + hunk.headLines - 1)
    })

    return out
  }, [diff, headLines, expanded])

  const lineTexts = React.useMemo(
    () => rows.filter((row): row is Extract<Row, { kind: 'line' }> => row.kind === 'line'),
    [rows]
  )
  const highlighted = useSyntaxHighlight(
    path,
    React.useMemo(() => lineTexts.map((row) => row.line.text), [lineTexts])
  )

  const threadsByLine = React.useMemo(() => {
    const map = new Map<number, RepoPrThread[]>()
    for (const thread of threads) {
      const line = thread.endLineNumber ?? thread.lineNumber
      if (!line) continue
      const list = map.get(line) ?? []
      list.push(thread)
      map.set(line, list)
    }
    return map
  }, [threads])

  const unanchoredThreads = React.useMemo(
    () => threads.filter((thread) => !(thread.endLineNumber ?? thread.lineNumber)),
    [threads]
  )

  if (isLoading) {
    return <Placeholder text="Loading diff…" />
  }
  if (error) {
    return <Placeholder text={error} tone="error" />
  }
  if (!diff) {
    return <Placeholder text="No diff available." />
  }
  if (diff.isBinary) {
    return <Placeholder text="Binary file — no textual diff." />
  }
  if (diff.hunks.length === 0) {
    return (
      <Placeholder
        text={
          diff.truncated
            ? 'This file is too large for the provider to return a diff.'
            : 'No changes in this file.'
        }
      />
    )
  }

  const selection = drag
    ? { start: Math.min(drag.start, drag.end), end: Math.max(drag.start, drag.end) }
    : anchor

  let lineCursor = -1

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {diff.truncated ? (
        <p className="text-muted-foreground border-b px-3 py-1.5 text-[11px]">{truncatedMessage}</p>
      ) : null}
      <table className="w-full border-collapse font-mono text-xs">
        <tbody>
          {rows.map((row) => {
            if (row.kind === 'expand') {
              if (!headLines) {
                return (
                  <tr key={row.key}>
                    <td
                      colSpan={3}
                      className="bg-muted/40 text-muted-foreground px-3 py-0.5 text-[11px]"
                    >
                      …
                    </td>
                  </tr>
                )
              }
              return (
                <tr key={row.key}>
                  <td colSpan={3} className="bg-muted/40 px-2 py-0.5">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px]"
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Map(current)
                          next.set(row.key, (current.get(row.key) ?? 0) + EXPAND_STEP)
                          return next
                        })
                      }
                    >
                      <ChevronsUpDownIcon className="size-3" />
                      Expand {Math.min(EXPAND_STEP, row.to - row.from + 1)} lines
                    </button>
                  </td>
                </tr>
              )
            }

            lineCursor += 1
            const { line } = row
            const tokens = highlighted?.[lineCursor] ?? null
            const headLine = line.headLine
            const inSelection =
              selection && headLine
                ? headLine >= selection.start && headLine <= selection.end
                : false
            const lineThreads = headLine ? threadsByLine.get(headLine) : undefined
            const showComposer = anchor && headLine === anchor.end

            return (
              <React.Fragment key={row.key}>
                <tr
                  className={cn(
                    'group',
                    line.kind === 'add' && 'bg-emerald-500/10',
                    line.kind === 'del' && 'bg-destructive/10',
                    inSelection && 'bg-primary/15'
                  )}
                  onMouseEnter={() => {
                    if (isDragging && headLine) {
                      setDrag((current) => (current ? { ...current, end: headLine } : current))
                    }
                  }}
                >
                  <td className="text-muted-foreground w-12 shrink-0 select-none px-2 text-right align-top tabular-nums">
                    {line.baseLine ?? ''}
                  </td>
                  <td className="text-muted-foreground w-16 shrink-0 select-none px-2 text-right align-top tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      {headLine && canComment ? (
                        <button
                          type="button"
                          aria-label={`Comment on line ${headLine}`}
                          title="Comment (drag for a range)"
                          className="text-primary opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          onMouseDown={(event) => {
                            event.preventDefault()
                            setAnchor(null)
                            setDrag({ start: headLine, end: headLine })
                            setIsDragging(true)
                          }}
                          onClick={() => setAnchor({ start: headLine, end: headLine })}
                        >
                          <PlusIcon className="size-3" />
                        </button>
                      ) : null}
                      {headLine ?? ''}
                    </span>
                  </td>
                  <td className="w-full whitespace-pre-wrap px-2 align-top">
                    <span
                      className={cn(
                        'select-none pr-1',
                        line.kind === 'add' && 'text-emerald-600 dark:text-emerald-400',
                        line.kind === 'del' && 'text-destructive',
                        line.kind === 'context' && 'text-muted-foreground'
                      )}
                    >
                      {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                    </span>
                    <LineText text={line.text} tokens={tokens} />
                  </td>
                </tr>

                {canComment && lineThreads?.length ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-1.5">
                      <div className="flex max-w-3xl flex-col gap-2">
                        {lineThreads.map((thread) => (
                          <ThreadCard
                            key={thread.providerThreadId || thread.id}
                            thread={thread}
                            onReply={onReply!}
                            onToggleResolved={onToggleResolved!}
                            defaultCollapsed={thread.isResolved}
                          />
                        ))}
                      </div>
                    </td>
                  </tr>
                ) : null}

                {canComment && showComposer && anchor ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-1.5">
                      <CommentComposer
                        className="max-w-3xl"
                        anchorLabel={`${path} L${anchor.start}${
                          anchor.end > anchor.start ? `\u2013L${anchor.end}` : ''
                        } · diff`}
                        onSubmit={async (content) => {
                          const message = await onCreateThread!(
                            {
                              filePath: path,
                              side: 'right',
                              startLine: anchor.start,
                              endLine: anchor.end,
                              origin: 'diff'
                            },
                            content
                          )
                          if (!message) setAnchor(null)
                          return message
                        }}
                        onCancel={() => setAnchor(null)}
                      />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>

      {canComment && unanchoredThreads.length > 0 ? (
        <div className="flex max-w-3xl flex-col gap-2 p-3">
          <p className="text-muted-foreground text-[11px]">File-level threads</p>
          {unanchoredThreads.map((thread) => (
            <ThreadCard
              key={thread.providerThreadId || thread.id}
              thread={thread}
              onReply={onReply!}
              onToggleResolved={onToggleResolved!}
              defaultCollapsed={thread.isResolved}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function LineText({
  text,
  tokens
}: {
  text: string
  tokens: HighlightedLine | null
}): React.JSX.Element {
  if (!tokens || tokens.length === 0) return <>{text}</>
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} style={token.color ? { color: token.color } : undefined}>
          {token.content}
        </span>
      ))}
    </>
  )
}

function Placeholder({
  text,
  tone = 'muted'
}: {
  text: string
  tone?: 'muted' | 'error'
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <p className={cn('text-xs', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
        {text}
      </p>
    </div>
  )
}
