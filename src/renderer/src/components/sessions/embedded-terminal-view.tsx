import * as React from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type { EmbeddedTerminal } from '@shared/embedded-terminal'

const TERMINAL_THEME = {
  background: '#000000',
  foreground: '#f2f2f2',
  cursor: '#f2f2f2',
  cursorAccent: '#000000',
  selectionBackground: '#3b82f680',
  black: '#000000',
  brightBlack: '#666666'
} as const

function isStoppedTerminalError(error: unknown): boolean {
  return String(error).toLowerCase().includes('terminal is no longer running')
}

export function EmbeddedTerminalView({
  terminal: session
}: {
  terminal: EmbeddedTerminal
}): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const terminalRef = React.useRef<Terminal | null>(null)

  const copy = React.useCallback(async (): Promise<void> => {
    const terminal = terminalRef.current
    if (!terminal?.hasSelection()) return
    await navigator.clipboard.writeText(terminal.getSelection())
  }, [])

  const paste = React.useCallback(async (): Promise<void> => {
    const text = await navigator.clipboard.readText()
    if (!text) return
    try {
      await window.api.embeddedTerminals.write(session.terminalId, text)
    } catch (error) {
      if (!isStoppedTerminalError(error)) throw error
    }
  }, [session.terminalId])

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: TERMINAL_THEME
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(new SearchAddon())
    terminal.loadAddon(new WebLinksAddon())
    terminal.open(host)
    terminalRef.current = terminal

    let disposed = false
    let lastSeq = 0
    let stopOutput = (): void => {}
    let connectionErrorShown = false
    const reportConnectionError = (error: unknown): void => {
      if (disposed || isStoppedTerminalError(error) || connectionErrorShown) return
      connectionErrorShown = true
      terminal.writeln(`\r\n\x1b[31mTerminal connection failed: ${String(error)}\x1b[0m`)
    }
    const input = terminal.onData((data) => {
      void window.api.embeddedTerminals.write(session.terminalId, data).catch(reportConnectionError)
    })
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'c' && terminal.hasSelection()) {
        void copy()
        return false
      }
      if (event.ctrlKey && event.shiftKey && key === 'c') {
        void copy()
        return false
      }
      if ((event.ctrlKey || event.metaKey) && key === 'v') {
        void paste()
        return false
      }
      if (event.ctrlKey && event.shiftKey && key === 'v') {
        void paste()
        return false
      }
      return true
    })

    const resize = new ResizeObserver(() => {
      fit.fit()
      if (terminal.cols > 0 && terminal.rows > 0) {
        void window.api.embeddedTerminals
          .resize(session.terminalId, terminal.cols, terminal.rows)
          .catch(reportConnectionError)
      }
    })
    resize.observe(host)

    void window.api.embeddedTerminals
      .onOutput((output) => {
        if (disposed || output.terminalId !== session.terminalId || output.seq <= lastSeq) return
        lastSeq = output.seq
        terminal.write(new Uint8Array(output.bytes))
      })
      .then(async (stop) => {
        if (disposed) {
          stop()
          return
        }
        stopOutput = stop
        const replay = await window.api.embeddedTerminals.replay(session.terminalId)
        if (disposed) return
        terminal.reset()
        terminal.write(new Uint8Array(replay.bytes))
        lastSeq = Math.max(lastSeq, replay.seq)
        fit.fit()
        terminal.focus()
      })
      .catch((error) => {
        reportConnectionError(error)
      })

    return () => {
      disposed = true
      stopOutput()
      resize.disconnect()
      input.dispose()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [copy, paste, session.terminalId])

  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-white/10 px-3 text-xs text-white/70">
        <span className="truncate font-medium text-white">{session.label}</span>
        <span className="truncate font-mono">{session.folderPath}</span>
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="min-h-0 flex-1 bg-black p-2">
            <div ref={hostRef} className="h-full w-full" aria-label={`Terminal ${session.label}`} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void copy()}>Copy</ContextMenuItem>
          <ContextMenuItem onSelect={() => void paste()}>Paste</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
