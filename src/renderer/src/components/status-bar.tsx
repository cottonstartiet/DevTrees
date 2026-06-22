import * as React from 'react'
import {
  CheckCircle2 as CheckCircle2Icon,
  Loader2 as Loader2Icon,
  XCircle as XCircleIcon
} from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSidebar } from '@/components/ui/sidebar'
import { useTasks, type Task } from '@/contexts/tasks-context'
import { cn } from '@/lib/utils'

function StatusIcon({ status }: { status: Task['status'] }): React.JSX.Element {
  if (status === 'running') {
    return <Loader2Icon className="text-muted-foreground size-3 shrink-0 animate-spin" />
  }
  if (status === 'success') {
    return <CheckCircle2Icon className="size-3 shrink-0 text-emerald-500" />
  }
  return <XCircleIcon className="text-destructive size-3 shrink-0" />
}

function formatTime(ts: number | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function StatusBar(): React.JSX.Element {
  const { tasks, runningTasks, latestTask } = useTasks()
  const { state, isMobile } = useSidebar()
  const extraCount = Math.max(0, runningTasks.length - 1)

  const segmentWidthClass = isMobile
    ? 'w-48'
    : state === 'collapsed'
      ? 'w-(--sidebar-width-icon)'
      : 'w-(--sidebar-width)'

  return (
    <div className="bg-sidebar text-sidebar-foreground relative z-20 flex h-5 w-full shrink-0 items-center border-t">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-full shrink-0 cursor-pointer items-center gap-2 px-3 text-left text-xs',
              'hover:bg-sidebar-accent/40 focus-visible:outline-hidden',
              segmentWidthClass
            )}
          >
            {latestTask ? (
              <>
                <StatusIcon status={latestTask.status} />
                <span className="text-foreground/90 min-w-0 flex-1 truncate">
                  {latestTask.label}
                </span>
                {extraCount > 0 ? (
                  <span className="bg-muted text-muted-foreground shrink-0 rounded-sm px-1.5 py-px font-mono text-[10px]">
                    +{extraCount}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground/70">Ready</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-80 p-0">
          <div className="border-b px-3 py-2 text-xs font-medium">Background tasks</div>
          {tasks.length === 0 ? (
            <p className="text-muted-foreground px-3 py-3 text-xs">No recent activity.</p>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-start gap-2 px-3 py-1.5 text-xs">
                  <span className="mt-0.5">
                    <StatusIcon status={t.status} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{t.label}</div>
                    {t.status === 'error' && t.errorMessage ? (
                      <div className="text-destructive mt-0.5 break-all">{t.errorMessage}</div>
                    ) : null}
                    <div className="text-muted-foreground mt-0.5 text-[10px]">
                      {t.status === 'running'
                        ? `started ${formatTime(t.startedAt)}`
                        : `${t.status === 'success' ? 'finished' : 'failed'} ${formatTime(t.endedAt)}`}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
