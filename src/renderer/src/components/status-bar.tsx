import * as React from 'react'
import {
  ArrowDown as ArrowDownIcon,
  ArrowUp as ArrowUpIcon,
  CheckCircle2 as CheckCircle2Icon,
  FolderGit2 as FolderGit2Icon,
  GitBranch as GitBranchIcon,
  GitPullRequest as GitPullRequestIcon,
  Loader2 as Loader2Icon,
  XCircle as XCircleIcon
} from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSidebar } from '@/components/ui/sidebar'
import { useTasks, type Task } from '@/contexts/tasks-context'
import { cn } from '@/lib/utils'

/** Live repo/branch/PR state for the active repository or worktree. Null when the
 * current view has no folder in focus (settings, history, sessions, empty home). */
export interface StatusBarContext {
  folderLabel: string
  folderPath: string
  branch: string | null
  isDetached: boolean
  isWorktree: boolean
  ahead: number
  behind: number
  hasRemote: boolean
  syncing: boolean
  pr: { id: number; title: string } | null
}

export interface StatusBarProps {
  context?: StatusBarContext | null
}

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

function Divider(): React.JSX.Element {
  return <span aria-hidden className="bg-border h-3 w-px shrink-0" />
}

function ContextSegments({ context }: { context: StatusBarContext }): React.JSX.Element {
  const { folderLabel, folderPath, branch, isDetached, isWorktree } = context
  const { ahead, behind, hasRemote, syncing, pr } = context

  const branchText = isDetached ? 'detached HEAD' : (branch ?? '—')
  const syncTitle = !hasRemote
    ? 'No upstream tracking branch'
    : behind > 0
      ? `${behind} behind${ahead > 0 ? `, ${ahead} ahead` : ''} of origin`
      : ahead > 0
        ? `${ahead} ahead of origin`
        : 'Up to date with origin'

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-xs">
      <Divider />

      <span
        className="text-muted-foreground flex min-w-0 max-w-[16rem] items-center gap-1.5"
        title={folderPath}
      >
        <FolderGit2Icon className="size-3 shrink-0" />
        <span className="truncate">{folderLabel}</span>
      </span>

      <Divider />

      <span
        className={cn(
          'flex min-w-0 max-w-[18rem] items-center gap-1.5 font-mono',
          isDetached ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground'
        )}
        title={isDetached ? 'HEAD is detached from any branch' : (branch ?? undefined)}
      >
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="truncate">{branchText}</span>
      </span>

      {/* Ahead/behind is tracked for the repository's default branch, not per-worktree. */}
      {!isWorktree && (
        <>
          <Divider />
          <span
            className={cn(
              'flex shrink-0 items-center gap-1.5 tabular-nums',
              behind > 0 ? 'text-foreground' : 'text-muted-foreground'
            )}
            title={syncTitle}
          >
            {syncing ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : !hasRemote ? (
              <span className="text-muted-foreground/70">no remote</span>
            ) : behind === 0 && ahead === 0 ? (
              <>
                <CheckCircle2Icon className="text-emerald-500 size-3" />
                <span className="text-muted-foreground/80">synced</span>
              </>
            ) : (
              <>
                {behind > 0 && (
                  <span className="flex items-center gap-0.5">
                    <ArrowDownIcon className="size-3" />
                    {behind > 99 ? '99+' : behind}
                  </span>
                )}
                {ahead > 0 && (
                  <span className="text-muted-foreground flex items-center gap-0.5">
                    <ArrowUpIcon className="size-3" />
                    {ahead > 99 ? '99+' : ahead}
                  </span>
                )}
              </>
            )}
          </span>
        </>
      )}

      {pr && (
        <>
          <Divider />
          <span
            className="text-muted-foreground flex min-w-0 max-w-[20rem] items-center gap-1.5"
            title={`PR #${pr.id}${pr.title ? ` — ${pr.title}` : ''}`}
          >
            <GitPullRequestIcon className="size-3 shrink-0" />
            <span className="shrink-0 font-mono">#{pr.id}</span>
            {pr.title ? <span className="truncate">{pr.title}</span> : null}
          </span>
        </>
      )}
    </div>
  )
}

export function StatusBar({ context = null }: StatusBarProps): React.JSX.Element {
  const { tasks, runningTasks, latestTask } = useTasks()
  const { state, isMobile } = useSidebar()
  const extraCount = Math.max(0, runningTasks.length - 1)

  const segmentWidthClass = isMobile
    ? 'w-48'
    : state === 'collapsed'
      ? 'w-(--sidebar-width-icon)'
      : 'w-(--sidebar-width)'

  return (
    <div className="bg-sidebar text-sidebar-foreground relative z-20 flex h-5 w-full shrink-0 items-center overflow-hidden border-t">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-full shrink-0 cursor-pointer items-center gap-2 px-3 text-left text-xs',
              'hover:bg-sidebar-accent/40 focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none focus-visible:ring-inset',
              segmentWidthClass
            )}
            aria-label="Background tasks"
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

      {context ? <ContextSegments context={context} /> : null}
    </div>
  )
}
