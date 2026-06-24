import * as React from 'react'
import { CircleDot as CircleDotIcon, X as XIcon } from 'lucide-react'

import type { CopilotSession } from '@shared/sessions'
import { useSessions } from '@/contexts/sessions-context'
import { cn } from '@/lib/utils'

const TAIL_BYTES = 16_384

// Strip the common ANSI/VT escape sequences (CSI, OSC, charset selects) and remaining bare control
// characters (excluding tab) so a preview line shows readable text rather than raw control codes.
/* eslint-disable no-control-regex */
const ANSI_PATTERN =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0]|\x1b[=>]/g
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/g
/* eslint-enable no-control-regex */

function capTail(text: string): string {
  return text.length > TAIL_BYTES ? text.slice(text.length - TAIL_BYTES) : text
}

/** Best-effort "last visible line" from raw terminal output for a lightweight preview. */
function lastVisibleLine(buffer: string): string {
  const normalized = buffer.replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let line = lines[i]
    // A bare carriage return rewrites the line (progress bars, spinners) — keep the latest segment.
    const cr = line.lastIndexOf('\r')
    if (cr >= 0) line = line.slice(cr + 1)
    const cleaned = line.replace(CONTROL_PATTERN, '').replace(/\t/g, ' ').trim()
    if (cleaned.length > 0) return cleaned
  }
  return ''
}

interface SessionTileProps {
  session: CopilotSession
  isActive: boolean
}

/**
 * A compact, non-terminal preview of a session (status, label, folder, last output line). Used in
 * the focus view's filmstrip. Deliberately does NOT mount an xterm so many can render cheaply.
 */
export function SessionTile({ session, isActive }: SessionTileProps): React.JSX.Element {
  const { selectSession, killSession, snapshot, subscribeData } = useSessions()
  const [lastLine, setLastLine] = React.useState('')
  const sessionId = session.id

  React.useEffect(() => {
    let disposed = false
    let tail = ''
    const recompute = (): void => {
      if (!disposed) setLastLine(lastVisibleLine(tail))
    }

    const unsubscribe = subscribeData(sessionId, (event) => {
      if (disposed) return
      tail = capTail(tail + event.data)
      recompute()
    })

    void snapshot(sessionId).then((snap) => {
      if (disposed || !snap) return
      // Only seed from the snapshot if live output hasn't already populated the tail.
      if (tail === '') {
        tail = capTail(snap.buffer)
        recompute()
      }
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [sessionId, snapshot, subscribeData])

  const isRunning = session.status === 'running'

  return (
    <button
      type="button"
      onClick={() => selectSession(sessionId)}
      title={`${session.label}\n${session.folderPath}`}
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
        <span className="min-w-0 flex-1 truncate font-medium">{session.label}</span>
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            killSession(sessionId)
          }}
          title={isRunning ? 'Stop and close session' : 'Close session'}
          className="hover:bg-accent hover:text-accent-foreground rounded-sm p-0.5 opacity-60 transition-opacity group-hover:opacity-100"
        >
          <XIcon className="size-3" />
        </span>
      </div>
      <span className="text-muted-foreground truncate font-mono text-[10px]">
        {lastLine || (isRunning ? 'Waiting for output…' : `exited (${session.exitCode ?? 0})`)}
      </span>
    </button>
  )
}
