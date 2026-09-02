import * as React from 'react'

import type { AgentSessionEvent } from '@shared/agent-session'

export function RawEventLog({ events }: { events: AgentSessionEvent[] }): React.JSX.Element {
  return (
    <details className="border-t">
      <summary className="text-muted-foreground focus-visible:ring-ring/50 cursor-pointer px-4 py-2 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-3">
        Raw SDK event log · {events.length}
      </summary>
      <div className="bg-muted/25 max-h-64 overflow-auto border-t p-3">
        <pre className="font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
          {events
            .map(
              (event) =>
                `${event.seq.toString().padStart(4, '0')} ${event.type}\n${JSON.stringify(event.data, null, 2)}`
            )
            .join('\n\n')}
        </pre>
      </div>
    </details>
  )
}
