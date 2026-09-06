import * as React from 'react'
import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  InfoIcon,
  ShieldQuestionIcon,
  TerminalIcon,
  UserIcon,
  XIcon
} from 'lucide-react'

import { MarkdownBody } from '@/components/pr-review/markdown-body'
import { cn } from '@/lib/utils'
import type { TerminalTimelineEntry } from '@shared/terminal-session'

function formatTime(timestamp?: string | null): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function Row({
  icon,
  title,
  timestamp,
  tone = 'default',
  children
}: {
  icon: React.ReactNode
  title: React.ReactNode
  timestamp?: string | null
  tone?: 'default' | 'accent' | 'error'
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="flex gap-3 px-4 py-3">
      <span
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border',
          tone === 'accent' && 'border-primary/30 bg-primary/10 text-primary',
          tone === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive',
          tone === 'default' && 'bg-muted/50 text-muted-foreground'
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatTime(timestamp)}
          </span>
        </div>
        {children}
      </div>
    </li>
  )
}

function Body({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{children}</p>
}

function Entry({ entry }: { entry: TerminalTimelineEntry }): React.JSX.Element | null {
  switch (entry.kind) {
    case 'userMessage':
      return (
        <Row icon={<UserIcon className="size-3.5" />} title="You" timestamp={entry.timestamp}>
          <MarkdownBody text={entry.text} className="text-sm" />
        </Row>
      )
    case 'assistantMessage':
      return (
        <Row
          icon={<BotIcon className="size-3.5" />}
          title="Copilot"
          timestamp={entry.timestamp}
          tone="accent"
        >
          <MarkdownBody text={entry.text} className="text-sm" />
        </Row>
      )
    case 'toolCall':
      return (
        <Row
          icon={<TerminalIcon className="size-3.5" />}
          title={
            <span className="flex items-center gap-2">
              <span className="font-mono text-xs">{entry.name}</span>
              {entry.success === true && <CheckIcon className="size-3 text-emerald-500" />}
              {entry.success === false && <XIcon className="size-3 text-destructive" />}
              {entry.success == null && (
                <span className="text-[11px] font-normal text-muted-foreground">running…</span>
              )}
            </span>
          }
          timestamp={entry.timestamp}
        >
          {entry.detail && (
            <pre className="overflow-x-auto rounded-md bg-muted/50 px-2 py-1 font-mono text-xs">
              {entry.detail}
            </pre>
          )}
          {entry.result && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 px-2 py-1 font-mono text-[11px] text-muted-foreground">
              {entry.result}
            </pre>
          )}
        </Row>
      )
    case 'permission':
      return (
        <Row
          icon={<ShieldQuestionIcon className="size-3.5" />}
          title="Permission"
          timestamp={entry.timestamp}
          tone={entry.resolution ? 'default' : 'accent'}
        >
          <Body>{entry.description}</Body>
          <p className="text-xs text-muted-foreground">
            {entry.resolution ?? 'Awaiting your answer.'}
          </p>
        </Row>
      )
    case 'notice':
      return (
        <Row
          icon={
            entry.level === 'error' ? (
              <AlertTriangleIcon className="size-3.5" />
            ) : (
              <InfoIcon className="size-3.5" />
            )
          }
          title={entry.level === 'error' ? 'Error' : 'Notice'}
          timestamp={entry.timestamp}
          tone={entry.level === 'error' ? 'error' : 'default'}
        >
          <Body>{entry.text}</Body>
        </Row>
      )
    default:
      return null
  }
}

/**
 * Rendering of a Copilot CLI session's history. Interactive requests are handled by the
 * shared session interaction panel below the timeline.
 */
export function TerminalTimeline({
  entries,
  className
}: {
  entries: TerminalTimelineEntry[]
  className?: string
}): React.JSX.Element {
  const endRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [entries.length])

  if (entries.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground',
          className
        )}
      >
        No activity recorded yet.
      </div>
    )
  }

  return (
    <div className={cn('flex-1 overflow-y-auto', className)}>
      <ul className="divide-y">
        {entries.map((entry) => (
          <Entry key={`${entry.kind}-${entry.seq}`} entry={entry} />
        ))}
      </ul>
      <div ref={endRef} />
    </div>
  )
}
