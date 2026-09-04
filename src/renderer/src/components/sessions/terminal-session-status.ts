import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  Loader2Icon,
  PlayIcon,
  type LucideIcon
} from 'lucide-react'

import type { TerminalSessionStatus } from '@shared/terminal-session'

/** Shared presentation for a terminal session's status, used by the badge and the dashboard tiles. */
export const TERMINAL_SESSION_STATUS_LABEL: Record<TerminalSessionStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  'waiting-input': 'Needs you',
  idle: 'Idle',
  done: 'Ended',
  error: 'Failed'
}

export const TERMINAL_SESSION_STATUS_TONE: Record<TerminalSessionStatus, string> = {
  starting: 'bg-muted text-muted-foreground',
  working: 'bg-primary/10 text-primary',
  'waiting-input': 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  idle: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  done: 'bg-muted text-muted-foreground',
  error: 'bg-destructive/10 text-destructive'
}

export const TERMINAL_SESSION_STATUS_ICON: Record<TerminalSessionStatus, LucideIcon> = {
  starting: PlayIcon,
  working: Loader2Icon,
  'waiting-input': CircleAlertIcon,
  idle: CircleCheckIcon,
  done: CircleCheckIcon,
  error: CircleXIcon
}
