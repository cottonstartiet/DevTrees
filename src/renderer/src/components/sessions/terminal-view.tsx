import * as React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

import type { CopilotSession } from '@shared/sessions'
import { useSessions } from '@/contexts/sessions-context'

const TERMINAL_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  selectionBackground: '#264f78'
}

interface TerminalViewProps {
  session: CopilotSession
}

/**
 * Renders a single Copilot session as an xterm terminal. On mount it replays the main-process
 * buffer (authoritative) then applies live output via the provider, deduplicating with sequence
 * numbers so no output is lost or doubled across the snapshot/subscribe boundary.
 */
export function TerminalView({ session }: TerminalViewProps): React.JSX.Element {
  const { subscribeData, snapshot, sendInput, resize } = useSessions()
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const sessionId = session.id
  const isRunning = session.status === 'running'

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let appliedSeq = 0
    let ready = false
    const queued: { seq: number; data: string }[] = []

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 13,
      theme: TERMINAL_THEME,
      scrollback: 10_000
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)

    const writeChunk = (event: { seq: number; data: string }): void => {
      if (event.seq <= appliedSeq) return
      appliedSeq = event.seq
      term.write(event.data)
    }

    // Subscribe BEFORE reading the snapshot so output produced during the async snapshot read is
    // queued rather than lost; queued chunks are de-duplicated against the snapshot's lastSeq.
    const unsubscribe = subscribeData(sessionId, (event) => {
      if (disposed) return
      if (!ready) {
        queued.push(event)
        return
      }
      writeChunk(event)
    })

    void snapshot(sessionId).then((snap) => {
      if (disposed) return
      if (snap) {
        if (snap.buffer) term.write(snap.buffer)
        appliedSeq = snap.lastSeq
      }
      ready = true
      for (const event of queued) writeChunk(event)
      queued.length = 0
    })

    const onDataDisposable = term.onData((data) => {
      sendInput(sessionId, data)
    })

    let lastCols = -1
    let lastRows = -1
    const applyFit = (): void => {
      if (disposed) return
      // Skip while the container is collapsed/zero-sized (e.g. an inactive tab or a grid cell mid
      // layout) — fitting against a 0-sized box yields bogus dimensions.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fitAddon.fit()
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols
          lastRows = term.rows
          resize(sessionId, term.cols, term.rows)
        }
      } catch {
        /* container may be hidden or zero-sized momentarily */
      }
    }
    applyFit()

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(applyFit, 100)
    })
    observer.observe(container)

    term.focus()

    return () => {
      disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      observer.disconnect()
      unsubscribe()
      onDataDisposable.dispose()
      term.dispose()
    }
    // Re-create the terminal only when the session identity or its running state changes.
  }, [sessionId, isRunning, subscribeData, snapshot, sendInput, resize])

  return <div ref={containerRef} className="h-full w-full overflow-hidden bg-[#1e1e1e] p-2" />
}
