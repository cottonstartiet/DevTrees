import * as React from 'react'
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  Clock3Icon,
  InfoIcon,
  XIcon
} from 'lucide-react'

import type { TerminalTimelineEntry } from '@shared/terminal-session'
import {
  remoteTimelinePresentation,
  type RemoteTimelineContext,
  type RemoteTimelinePresentation
} from './session-timeline-presentation'

function outcomeIcon(
  presentation: Extract<RemoteTimelinePresentation, { display: 'collapsed' }>
): React.JSX.Element {
  if (presentation.outcome === 'success')
    return <CheckIcon className="size-3.5 text-emerald-500" aria-hidden="true" />
  if (presentation.outcome === 'failure')
    return <XIcon className="size-3.5 text-destructive" aria-hidden="true" />
  return <Clock3Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
}

function acpDetail(entry: Extract<TerminalTimelineEntry, { kind: 'acp' }>): React.JSX.Element {
  return (
    <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
      {JSON.stringify(entry.data, null, 2)}
    </pre>
  )
}

function collapsedDetail(entry: TerminalTimelineEntry): React.ReactNode {
  if (entry.kind === 'toolCall') {
    return (
      <div className="space-y-2">
        {entry.detail ? (
          <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-xs">
            {entry.detail}
          </pre>
        ) : null}
        {entry.result ? (
          <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 font-mono text-xs text-muted-foreground">
            {entry.result}
          </pre>
        ) : null}
      </div>
    )
  }
  if (entry.kind === 'permission') {
    return (
      <div className="space-y-1 text-sm">
        <p className="whitespace-pre-wrap break-words">{entry.description}</p>
        <p className="text-xs text-muted-foreground">{entry.resolution}</p>
      </div>
    )
  }
  if (entry.kind === 'acp') return acpDetail(entry)
  return null
}

export function RemoteTimelineEntry({
  entry,
  context
}: {
  entry: TerminalTimelineEntry
  context: RemoteTimelineContext
}): React.JSX.Element | null {
  const [expanded, setExpanded] = React.useState(false)
  const presentation = remoteTimelinePresentation(entry, context)

  if (presentation.display === 'omit') return null

  if (presentation.display === 'message') {
    return (
      <div
        className={`max-w-3xl whitespace-pre-wrap break-words rounded-lg border p-3 text-sm ${
          presentation.role === 'user' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-card'
        }`}
      >
        {presentation.text}
      </div>
    )
  }

  if (presentation.display === 'notice') {
    const error = presentation.tone === 'error'
    return (
      <div
        role={error ? 'alert' : 'status'}
        className={`flex max-w-3xl gap-2 rounded-lg border p-3 text-sm ${
          error
            ? 'border-destructive/30 bg-destructive/5 text-destructive'
            : 'bg-card text-muted-foreground'
        }`}
      >
        {error ? (
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        ) : (
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className="font-medium text-foreground">{presentation.summary}</p>
          <p className="whitespace-pre-wrap break-words">{presentation.detail}</p>
        </div>
      </div>
    )
  }

  if (presentation.display === 'waiting') {
    return (
      <div className="max-w-3xl rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
        <p className="text-sm font-medium">{presentation.summary}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {presentation.detail}
        </p>
      </div>
    )
  }

  return (
    <details
      className="group max-w-3xl overflow-hidden rounded-lg border bg-card"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="remote-touch flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        {outcomeIcon(presentation)}
        <span className="min-w-0 flex-1 truncate font-medium">{presentation.summary}</span>
        {presentation.status ? (
          <span className="shrink-0 text-xs text-muted-foreground">{presentation.status}</span>
        ) : null}
      </summary>
      {expanded ? <div className="border-t p-3">{collapsedDetail(entry)}</div> : null}
    </details>
  )
}
