import * as React from 'react'
import { ChevronsUpDown as ChevronsUpDownIcon, Plus as PlusIcon } from 'lucide-react'

import { CommentComposer } from '@/components/pr-review/comment-composer'
import {
  alignSplitRows,
  buildDiffRows,
  type DiffDisplayRow,
  type SplitDiffRow
} from '@/components/pr-review/diff-rows'
import { ThreadCard } from '@/components/pr-review/thread-card'
import { useSyntaxHighlight, type HighlightedLine } from '@/hooks/use-syntax-highlight'
import { cn } from '@/lib/utils'
import type { PrCommentAnchor, PrDiffLine, PrFileDiff } from '@shared/pr-review'
import type { RepoPrThread } from '@shared/reviews'

const EXPAND_STEP = 20

export type DiffLayout = 'inline' | 'split'

export interface DiffViewProps {
  path: string
  layout: DiffLayout
  diff: PrFileDiff | null
  error: string | null
  isLoading: boolean
  threads?: RepoPrThread[]
  headText: string | null
  onCreateThread?: (anchor: PrCommentAnchor, content: string) => Promise<string | null>
  onReply?: (thread: RepoPrThread, content: string) => Promise<string | null>
  onToggleResolved?: (thread: RepoPrThread, resolved: boolean) => Promise<string | null>
  truncatedMessage?: string
}

type LineRange = { start: number; end: number }
type SetLineRange = React.Dispatch<React.SetStateAction<LineRange | null>>

/**
 * Code review diff for one file. Inline and split layouts share the same normalized hunk model,
 * syntax highlighting, context expansion, and head-side comment anchors.
 */
export function DiffView({
  path,
  layout,
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
  const [drag, setDrag] = React.useState<LineRange | null>(null)
  const [isDragging, setIsDragging] = React.useState(false)
  const [anchor, setAnchor] = React.useState<LineRange | null>(null)

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
  const rows = React.useMemo(
    () => buildDiffRows(diff, headLines, expanded),
    [diff, headLines, expanded]
  )
  const splitRows = React.useMemo(() => alignSplitRows(rows), [rows])
  const inlineHighlightTexts = React.useMemo(
    () =>
      layout === 'inline'
        ? rows
            .filter((row): row is Extract<DiffDisplayRow, { kind: 'line' }> => row.kind === 'line')
            .map((row) => row.line.text)
        : [],
    [layout, rows]
  )
  const splitHighlightTexts = React.useMemo(
    () =>
      layout === 'split'
        ? splitRows
            .filter((row): row is Extract<SplitDiffRow, { kind: 'line' }> => row.kind === 'line')
            .reduce(
              (texts, row) => {
                texts.left.push(row.left?.text ?? '')
                texts.right.push(row.right?.text ?? '')
                return texts
              },
              { left: [] as string[], right: [] as string[] }
            )
        : { left: [], right: [] },
    [layout, splitRows]
  )
  const inlineHighlighted = useSyntaxHighlight(path, inlineHighlightTexts)
  const leftHighlighted = useSyntaxHighlight(path, splitHighlightTexts.left)
  const rightHighlighted = useSyntaxHighlight(path, splitHighlightTexts.right)

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

  const expandRow = React.useCallback((row: { key: string }): void => {
    setExpanded((current) => {
      const next = new Map(current)
      next.set(row.key, (current.get(row.key) ?? 0) + EXPAND_STEP)
      return next
    })
  }, [])

  if (isLoading) return <Placeholder text="Loading diff…" />
  if (error) return <Placeholder text={error} tone="error" />
  if (!diff) return <Placeholder text="No diff available." />
  if (diff.isBinary) return <Placeholder text="Binary file — no textual diff." />
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

  const common: CommonTableProps = {
    path,
    inlineHighlighted,
    leftHighlighted,
    rightHighlighted,
    selection,
    anchor,
    isDragging,
    setAnchor,
    setDrag,
    setIsDragging,
    threadsByLine,
    canComment,
    onCreateThread,
    onReply,
    onToggleResolved,
    onExpand: expandRow
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {diff.truncated ? (
        <p className="text-muted-foreground sticky left-0 border-b px-3 py-1.5 text-[11px]">
          {truncatedMessage}
        </p>
      ) : null}
      {layout === 'split' ? (
        <SplitDiffTable {...common} rows={splitRows} />
      ) : (
        <InlineDiffTable {...common} rows={rows} />
      )}

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

interface CommonTableProps {
  path: string
  inlineHighlighted: HighlightedLine[] | null
  leftHighlighted: HighlightedLine[] | null
  rightHighlighted: HighlightedLine[] | null
  selection: LineRange | null
  anchor: LineRange | null
  isDragging: boolean
  setAnchor: SetLineRange
  setDrag: SetLineRange
  setIsDragging: React.Dispatch<React.SetStateAction<boolean>>
  threadsByLine: Map<number, RepoPrThread[]>
  canComment: boolean
  onCreateThread?: (anchor: PrCommentAnchor, content: string) => Promise<string | null>
  onReply?: (thread: RepoPrThread, content: string) => Promise<string | null>
  onToggleResolved?: (thread: RepoPrThread, resolved: boolean) => Promise<string | null>
  onExpand: (row: { key: string }) => void
}

function InlineDiffTable({
  rows,
  ...props
}: CommonTableProps & { rows: DiffDisplayRow[] }): React.JSX.Element {
  const tokenByKey = new Map(
    rows
      .filter((row): row is Extract<DiffDisplayRow, { kind: 'line' }> => row.kind === 'line')
      .map((row, index) => [row.key, props.inlineHighlighted?.[index] ?? null])
  )

  return (
    <table className="min-w-full border-collapse font-mono text-xs">
      <tbody>
        {rows.map((row) => {
          if (row.kind === 'expand') {
            return (
              <ExpandRow
                key={row.key}
                row={row}
                colSpan={3}
                hasContent={row.from > 0}
                onExpand={props.onExpand}
              />
            )
          }

          const tokens = tokenByKey.get(row.key) ?? null
          const { line } = row
          const headLine = line.headLine
          const selected = isSelected(props.selection, headLine)

          return (
            <React.Fragment key={row.key}>
              <tr
                className={lineRowClass(line.kind, selected)}
                onMouseEnter={() => extendDrag(props, headLine)}
              >
                <LineNumber value={line.baseLine} label="Old line" />
                <HeadLineNumber value={headLine} {...commentGutterProps(props)} />
                <CodeCell line={line} tokens={tokens} />
              </tr>
              <ReviewRows
                {...reviewRowProps(props)}
                colSpan={3}
                headLine={headLine}
                threads={headLine ? props.threadsByLine.get(headLine) : undefined}
              />
            </React.Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function SplitDiffTable({
  rows,
  ...props
}: CommonTableProps & { rows: SplitDiffRow[] }): React.JSX.Element {
  const tokensByKey = new Map(
    rows
      .filter((row): row is Extract<SplitDiffRow, { kind: 'line' }> => row.kind === 'line')
      .map((row, index) => [
        row.key,
        {
          left: props.leftHighlighted?.[index] ?? null,
          right: props.rightHighlighted?.[index] ?? null
        }
      ])
  )

  return (
    <table className="min-w-[960px] border-collapse font-mono text-xs">
      <colgroup>
        <col className="w-12" />
        <col className="w-1/2" />
        <col className="w-16" />
        <col className="w-1/2" />
      </colgroup>
      <thead className="bg-muted/90 text-muted-foreground sticky top-0 z-10 text-[11px]">
        <tr>
          <th colSpan={2} className="border-r px-3 py-1 text-left font-medium">
            Old
          </th>
          <th colSpan={2} className="px-3 py-1 text-left font-medium">
            New
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          if (row.kind === 'expand') {
            return (
              <ExpandRow
                key={row.key}
                row={row}
                colSpan={4}
                hasContent={row.from > 0}
                onExpand={props.onExpand}
              />
            )
          }

          const rowTokens = tokensByKey.get(row.key)
          const headLine = row.right?.headLine ?? null
          const selected = isSelected(props.selection, headLine)

          return (
            <React.Fragment key={row.key}>
              <tr className="group" onMouseEnter={() => extendDrag(props, headLine)}>
                <LineNumber
                  value={row.left?.baseLine ?? null}
                  label="Old line"
                  className={cellBackground(row.left?.kind, false)}
                />
                <SplitCodeCell line={row.left} tokens={rowTokens?.left ?? null} selected={false} />
                <HeadLineNumber
                  value={headLine}
                  {...commentGutterProps(props)}
                  className={cellBackground(row.right?.kind, selected)}
                />
                <SplitCodeCell
                  line={row.right}
                  tokens={rowTokens?.right ?? null}
                  selected={selected}
                />
              </tr>
              <ReviewRows
                {...reviewRowProps(props)}
                colSpan={4}
                headLine={headLine}
                threads={headLine ? props.threadsByLine.get(headLine) : undefined}
              />
            </React.Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function commentGutterProps(props: CommonTableProps): {
  canComment: boolean
  setAnchor: SetLineRange
  setDrag: SetLineRange
  setIsDragging: React.Dispatch<React.SetStateAction<boolean>>
} {
  return {
    canComment: props.canComment,
    setAnchor: props.setAnchor,
    setDrag: props.setDrag,
    setIsDragging: props.setIsDragging
  }
}

function reviewRowProps(props: CommonTableProps): {
  path: string
  anchor: LineRange | null
  setAnchor: SetLineRange
  onCreateThread?: CommonTableProps['onCreateThread']
  onReply?: CommonTableProps['onReply']
  onToggleResolved?: CommonTableProps['onToggleResolved']
} {
  return {
    path: props.path,
    anchor: props.anchor,
    setAnchor: props.setAnchor,
    onCreateThread: props.onCreateThread,
    onReply: props.onReply,
    onToggleResolved: props.onToggleResolved
  }
}

function extendDrag(props: CommonTableProps, headLine: number | null): void {
  if (!props.isDragging || !headLine) return
  props.setDrag((current) => (current ? { ...current, end: headLine } : current))
}

function isSelected(selection: LineRange | null, headLine: number | null): boolean {
  return Boolean(selection && headLine && headLine >= selection.start && headLine <= selection.end)
}

function ExpandRow({
  row,
  colSpan,
  hasContent,
  onExpand
}: {
  row: Extract<DiffDisplayRow, { kind: 'expand' }>
  colSpan: number
  hasContent: boolean
  onExpand: (row: { key: string }) => void
}): React.JSX.Element {
  return (
    <tr>
      <td colSpan={colSpan} className="bg-muted/40 px-2 py-0.5">
        {hasContent ? (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px]"
            onClick={() => onExpand(row)}
          >
            <ChevronsUpDownIcon className="size-3" />
            Expand {Math.min(EXPAND_STEP, row.to - row.from + 1)} lines
          </button>
        ) : (
          <span className="text-muted-foreground text-[11px]">…</span>
        )}
      </td>
    </tr>
  )
}

function LineNumber({
  value,
  label,
  className
}: {
  value: number | null
  label: string
  className?: string
}): React.JSX.Element {
  return (
    <td
      aria-label={value ? `${label} ${value}` : undefined}
      className={cn(
        'text-muted-foreground w-12 select-none border-r px-2 text-right align-top tabular-nums',
        className
      )}
    >
      {value ?? ''}
    </td>
  )
}

function HeadLineNumber({
  value,
  canComment,
  setAnchor,
  setDrag,
  setIsDragging,
  className
}: {
  value: number | null
  canComment: boolean
  setAnchor: SetLineRange
  setDrag: SetLineRange
  setIsDragging: React.Dispatch<React.SetStateAction<boolean>>
  className?: string
}): React.JSX.Element {
  return (
    <td
      aria-label={value ? `New line ${value}` : undefined}
      className={cn(
        'text-muted-foreground w-16 select-none border-r px-2 text-right align-top tabular-nums',
        className
      )}
    >
      <span className="inline-flex items-center gap-1">
        {value && canComment ? (
          <button
            type="button"
            aria-label={`Comment on line ${value}`}
            title="Comment (drag for a range)"
            className="text-primary opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onMouseDown={(event) => {
              event.preventDefault()
              setAnchor(null)
              setDrag({ start: value, end: value })
              setIsDragging(true)
            }}
            onClick={() => setAnchor({ start: value, end: value })}
          >
            <PlusIcon className="size-3" />
          </button>
        ) : null}
        {value ?? ''}
      </span>
    </td>
  )
}

function CodeCell({
  line,
  tokens
}: {
  line: PrDiffLine
  tokens: HighlightedLine | null
}): React.JSX.Element {
  return (
    <td className="w-full px-2 align-top whitespace-pre">
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
  )
}

function SplitCodeCell({
  line,
  tokens,
  selected
}: {
  line: PrDiffLine | null
  tokens: HighlightedLine | null
  selected: boolean
}): React.JSX.Element {
  return (
    <td
      className={cn(
        'min-w-[420px] border-r px-2 align-top whitespace-pre',
        cellBackground(line?.kind, selected)
      )}
    >
      {line ? <LineText text={line.text} tokens={tokens} /> : null}
    </td>
  )
}

function ReviewRows({
  colSpan,
  path,
  headLine,
  threads,
  anchor,
  setAnchor,
  onCreateThread,
  onReply,
  onToggleResolved
}: {
  colSpan: number
  path: string
  headLine: number | null
  threads: RepoPrThread[] | undefined
  anchor: LineRange | null
  setAnchor: SetLineRange
  onCreateThread?: (anchor: PrCommentAnchor, content: string) => Promise<string | null>
  onReply?: (thread: RepoPrThread, content: string) => Promise<string | null>
  onToggleResolved?: (thread: RepoPrThread, resolved: boolean) => Promise<string | null>
}): React.JSX.Element {
  const canComment = Boolean(onCreateThread && onReply && onToggleResolved)
  const showComposer = Boolean(anchor && headLine === anchor.end)

  return (
    <>
      {canComment && threads?.length ? (
        <tr>
          <td colSpan={colSpan} className="px-3 py-1.5">
            <div className="flex max-w-3xl flex-col gap-2">
              {threads.map((thread) => (
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
          <td colSpan={colSpan} className="px-3 py-1.5">
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
    </>
  )
}

function lineRowClass(kind: PrDiffLine['kind'], selected: boolean): string {
  return cn(
    'group',
    kind === 'add' && 'bg-emerald-500/10',
    kind === 'del' && 'bg-destructive/10',
    selected && 'bg-primary/15'
  )
}

function cellBackground(kind: PrDiffLine['kind'] | undefined, selected: boolean): string {
  return cn(
    kind === 'add' && 'bg-emerald-500/10',
    kind === 'del' && 'bg-destructive/10',
    selected && 'bg-primary/15'
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
