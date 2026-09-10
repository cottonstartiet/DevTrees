import { Loader2Icon } from 'lucide-react'

import {
  TERMINAL_SESSION_STATUS_LABEL,
  TERMINAL_SESSION_STATUS_TONE
} from '@/components/sessions/terminal-session-status'
import { cn } from '@/lib/utils'
import type { TerminalSessionStatus } from '@shared/terminal-session'

function StatusContent({ status }: { status: TerminalSessionStatus }): React.JSX.Element {
  return (
    <>
      {status === 'working' && (
        <Loader2Icon className="size-3 animate-spin motion-reduce:animate-none" />
      )}
      {TERMINAL_SESSION_STATUS_LABEL[status]}
    </>
  )
}

export function TerminalSessionStatusBadge({
  status,
  className
}: {
  status: TerminalSessionStatus
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        TERMINAL_SESSION_STATUS_TONE[status],
        className
      )}
    >
      <StatusContent status={status} />
    </span>
  )
}
