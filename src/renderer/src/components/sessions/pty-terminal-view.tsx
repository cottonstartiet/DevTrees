import * as React from 'react'
import { CopyIcon, ClipboardPasteIcon, RefreshCwIcon, SquareIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { terminalFor, type PtyTerminal } from '@/lib/pty-terminal'
import type { TerminalSession } from '@shared/terminal-session'

function ConnectedTerminal({ terminal }: { terminal: PtyTerminal }): React.JSX.Element {
  const host = React.useRef<HTMLDivElement>(null)
  const state = React.useSyncExternalStore(terminal.subscribe, terminal.getSnapshot)
  const [stopping, setStopping] = React.useState(false)

  React.useEffect(() => {
    if (host.current) return terminal.mount(host.current)
    return undefined
  }, [terminal])

  const run = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <p className="text-muted-foreground min-w-0 flex-1 text-xs" role="status">
          {state.ended
            ? 'Session ended. Terminal output is read-only.'
            : state.connected
              ? 'Answer questions and permissions directly in the terminal.'
              : 'Connecting terminal display...'}
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void run(async () => {
              const selection = terminal.terminal.getSelection()
              if (!selection) throw new Error('Select terminal text to copy.')
              await navigator.clipboard.writeText(selection)
            })
          }
        >
          <CopyIcon className="size-3.5" /> Copy
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!state.connected || state.ended}
          onClick={() =>
            void run(async () => {
              terminal.terminal.paste(await navigator.clipboard.readText())
              terminal.terminal.focus()
            })
          }
        >
          <ClipboardPasteIcon className="size-3.5" /> Paste
        </Button>
        {!state.ended && (
          <Button
            size="sm"
            variant="outline"
            disabled={stopping}
            onClick={() =>
              void run(async () => {
                setStopping(true)
                try {
                  await terminal.stop()
                } finally {
                  setStopping(false)
                }
              })
            }
          >
            <SquareIcon className="size-3.5" /> End session
          </Button>
        )}
      </div>
      {state.error && !state.ended && (
        <div className="bg-muted flex items-center gap-3 border-b px-4 py-3" role="alert">
          <p className="min-w-0 flex-1 text-xs">
            <strong>Terminal display disconnected.</strong> {state.error}
          </p>
          <Button size="sm" variant="outline" onClick={() => void terminal.connect()}>
            <RefreshCwIcon className="size-3.5" /> Reconnect
          </Button>
        </div>
      )}
      <div
        ref={host}
        className="min-h-0 flex-1 overflow-hidden bg-black p-2 [color-scheme:dark] focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring"
        aria-label="Interactive Copilot terminal"
      />
    </div>
  )
}

export function PtyTerminalView({ session }: { session: TerminalSession }): React.JSX.Element {
  const [terminal] = React.useState(() => terminalFor(session))
  if (!terminal) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm">
        {session.transport === 'external'
          ? 'This session runs in an external terminal. Respond there; its transcript is available here.'
          : 'This terminal is no longer connected. Resume explicitly to start a new process, or view the transcript.'}
      </div>
    )
  }
  return <ConnectedTerminal terminal={terminal} />
}
