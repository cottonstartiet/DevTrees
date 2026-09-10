import { ChevronRightIcon, Loader2Icon } from 'lucide-react'

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

export function TerminalSessionStatusButton({
  status,
  className,
  ...props
}: {
  status: TerminalSessionStatus
  className?: string
} & Omit<React.ComponentProps<'button'>, 'children' | 'type'>): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'focus-visible:ring-ring/50 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium outline-none transition-[filter,box-shadow] hover:brightness-95 focus-visible:ring-[3px] active:brightness-90 dark:hover:brightness-110 dark:active:brightness-125',
        TERMINAL_SESSION_STATUS_TONE[status],
        className
      )}
      {...props}
    >
      <StatusContent status={status} />
      <ChevronRightIcon aria-hidden="true" className="size-3" />
    </button>
  )
}
