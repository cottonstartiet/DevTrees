import * as React from 'react'
import { CheckIcon, Loader2Icon, TerminalIcon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { JsonValue } from '@shared/agent-session'

export type ToolTimelineItem = {
  id: string
  name: string
  arguments?: JsonValue
  progress?: string
  result?: JsonValue
  completed: boolean
  failed: boolean
}

function formatValue(value: JsonValue | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

export function ToolCard({ tool }: { tool: ToolTimelineItem }): React.JSX.Element {
  return (
    <details className="bg-muted/25 rounded-md border" open={!tool.completed}>
      <summary className="focus-visible:ring-ring/50 flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-3">
        <TerminalIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono font-medium">{tool.name}</span>
        {tool.completed ? (
          tool.failed ? (
            <XIcon className="text-destructive size-3.5" />
          ) : (
            <CheckIcon className="text-muted-foreground size-3.5" />
          )
        ) : (
          <Loader2Icon className="text-muted-foreground size-3.5 animate-spin" />
        )}
      </summary>
      <div className="space-y-2 border-t px-3 py-2">
        {tool.progress ? (
          <p className="text-muted-foreground text-[11px]">{tool.progress}</p>
        ) : null}
        {tool.arguments !== undefined ? (
          <pre className="bg-background/70 max-h-48 overflow-auto rounded border p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
            {formatValue(tool.arguments)}
          </pre>
        ) : null}
        {tool.result !== undefined ? (
          <pre
            className={cn(
              'bg-background/70 max-h-56 overflow-auto rounded border p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap',
              tool.failed && 'text-destructive'
            )}
          >
            {formatValue(tool.result)}
          </pre>
        ) : null}
      </div>
    </details>
  )
}
