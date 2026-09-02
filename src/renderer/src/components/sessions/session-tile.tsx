import * as React from 'react'
import { CircleDot as CircleDotIcon, X as XIcon } from 'lucide-react'

import type { CopilotSession } from '@shared/sessions'
import { useSessions } from '@/contexts/sessions-context'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { sessionPrimaryLabel, sessionRepoLabel } from '@/lib/session-label'
import { capTerminalTail, lastVisibleTerminalLine } from '@/lib/terminal-output'
import { cn } from '@/lib/utils'

interface SessionTileProps {
  session: CopilotSession
  isActive: boolean
}

/**
 * A compact, non-terminal preview of a session (status, label, folder, last output line). Used in
 * the focus view's filmstrip. Deliberately does NOT mount an xterm so many can render cheaply.
 */
export function SessionTile({ session, isActive }: SessionTileProps): React.JSX.Element {
  const { selectSession, requestCloseSession, snapshot, subscribeData } = useSessions()
  const [lastLine, setLastLine] = React.useState('')
  const sessionId = session.id

  React.useEffect(() => {
    let disposed = false
    let tail = ''
    // A streaming decoder so multibyte characters split across chunks aren't corrupted.
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const recompute = (): void => {
      if (!disposed) setLastLine(lastVisibleTerminalLine(tail))
    }

    const unsubscribe = subscribeData(sessionId, (event) => {
      if (disposed) return
      tail = capTerminalTail(tail + decoder.decode(event.data, { stream: true }))
      recompute()
    })

    void snapshot(sessionId).then((snap) => {
      if (disposed || !snap) return
      // Only seed from the snapshot if live output hasn't already populated the tail.
      if (tail === '') {
        tail = capTerminalTail(new TextDecoder('utf-8', { fatal: false }).decode(snap.buffer))
        recompute()
      }
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [sessionId, snapshot, subscribeData])

  const isRunning = session.status === 'running'
  const primary = sessionPrimaryLabel(session)
  const repoLabel = sessionRepoLabel(session)
  const tooltip = [repoLabel ? `${primary} · ${repoLabel}` : primary, session.folderPath].join('\n')

  return (
    <button
      type="button"
      onClick={() => selectSession(sessionId)}
      title={tooltip}
      className={cn(
        'group bg-background/60 hover:bg-accent/60 relative flex w-48 shrink-0 flex-col gap-1 rounded-md border p-2 text-left text-xs transition-colors',
        isActive ? 'border-primary ring-primary/40 ring-1' : 'border-border'
      )}
    >
      <div className="flex items-center gap-1.5">
        <CircleDotIcon
          className={cn(
            'size-3 shrink-0',
            isRunning ? 'text-emerald-500' : 'text-muted-foreground/50'
          )}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{primary}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
              title="Close session"
              className="hover:bg-accent hover:text-accent-foreground rounded-sm p-0.5 opacity-60 transition-opacity group-hover:opacity-100"
            >
              <XIcon className="size-3" />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-28"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuItem variant="destructive" onSelect={() => requestCloseSession(sessionId)}>
              Close
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <span className="text-muted-foreground truncate font-mono text-[10px]">
        {lastLine || (isRunning ? 'Waiting for output…' : `exited (${session.exitCode ?? 0})`)}
      </span>
    </button>
  )
}
