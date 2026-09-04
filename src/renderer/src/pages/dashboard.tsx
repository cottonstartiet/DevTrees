import * as React from 'react'
import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  GitPullRequestIcon,
  Loader2Icon,
  RefreshCwIcon
} from 'lucide-react'

import { DashboardCard } from '@/components/detail/dashboard-card'
import {
  TERMINAL_SESSION_STATUS_ICON,
  TERMINAL_SESSION_STATUS_LABEL,
  TERMINAL_SESSION_STATUS_TONE
} from '@/components/sessions/terminal-session-status'
import { Button } from '@/components/ui/button'
import { useDashboard } from '@/contexts/dashboard-context'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import {
  type DashboardAssignedPr,
  type DashboardReviewState
} from '@/hooks/use-dashboard-pr-reviews'
import { cn } from '@/lib/utils'
import { isTerminalSessionFinished } from '@shared/terminal-session'
import type { Repository } from '@shared/repository'

function ReviewStatus({ state }: { state?: DashboardReviewState }): React.JSX.Element {
  if (!state) {
    return <span className="text-muted-foreground text-[10px]">Awaiting review</span>
  }
  if (state === 'queued' || state === 'running') {
    return (
      <span className="text-muted-foreground flex items-center gap-1 text-[10px]">
        <Loader2Icon className="size-3 animate-spin" />
        {state === 'queued' ? 'Queued' : 'Reviewing'}
      </span>
    )
  }
  if (state === 'completed') {
    return (
      <span className="text-muted-foreground flex items-center gap-1 text-[10px]">
        <CheckCircle2Icon className="size-3" />
        Complete
      </span>
    )
  }
  return (
    <span className="text-destructive flex items-center gap-1 text-[10px]">
      <AlertCircleIcon className="size-3" />
      Failed
    </span>
  )
}

function PullRequestRow({
  item,
  sessionAvailable,
  onOpenSession
}: {
  item: DashboardAssignedPr
  sessionAvailable: boolean
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element {
  const review = item.review
  return (
    <li className="bg-background/60 rounded-md border">
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]">
          #{item.pr.id}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-medium">{item.pr.title}</span>
            {item.pr.isDraft ? (
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
                Draft
              </span>
            ) : null}
          </div>
          <p className="text-muted-foreground truncate text-[10px]">
            {item.repository.name} · {item.pr.author || 'Unknown'} · {item.pr.sourceRef} →{' '}
            {item.pr.targetRef}
          </p>
        </div>
        <ReviewStatus state={review?.state} />
        {review?.sessionId && sessionAvailable ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            onClick={() => onOpenSession(review.sessionId)}
          >
            Session
            <ChevronRightIcon className="size-3" />
          </Button>
        ) : null}
      </div>
      {review?.error ? (
        <p className="text-destructive border-t px-3 py-2 text-xs">{review.error}</p>
      ) : null}
    </li>
  )
}

export function DashboardPage({
  repositories,
  onNavigateToSessions
}: {
  repositories: Repository[]
  onNavigateToSessions: () => void
}): React.JSX.Element {
  const { sessions, select } = useTerminalSessions()
  const { items, errors, isLoading, refresh } = useDashboard()
  const liveSessions = sessions.filter((session) => !isTerminalSessionFinished(session.status))

  const openSession = React.useCallback(
    (sessionId: string): void => {
      select(sessionId)
      onNavigateToSessions()
    },
    [onNavigateToSessions, select]
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold tracking-tight">Activity</h3>
          <p className="text-muted-foreground text-xs">
            Attention and review work across {repositories.length}{' '}
            {repositories.length === 1 ? 'repository' : 'repositories'}.
          </p>
        </div>

        <DashboardCard
          title="Active sessions"
          description={`${liveSessions.length} Copilot session${liveSessions.length === 1 ? '' : 's'} running`}
        >
          {liveSessions.length === 0 ? (
            <p className="text-muted-foreground text-xs italic">No Copilot sessions are running.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {liveSessions.map((session) => {
                const StatusIcon = TERMINAL_SESSION_STATUS_ICON[session.status]
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => openSession(session.id)}
                    className={cn(
                      'bg-background/60 hover:bg-accent/60 focus-visible:ring-ring/50 flex w-full flex-col gap-2 rounded-md border p-3 text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-3'
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          'flex size-6 shrink-0 items-center justify-center rounded-md',
                          TERMINAL_SESSION_STATUS_TONE[session.status]
                        )}
                      >
                        <StatusIcon
                          className={cn('size-3.5', session.status === 'working' && 'animate-spin')}
                        />
                      </span>
                      <span className="truncate text-xs font-medium">{session.label}</span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-muted-foreground truncate text-[10px]">
                        {TERMINAL_SESSION_STATUS_LABEL[session.status]}
                        {session.repository ? ` · ${session.repository}` : ''}
                        {session.branch ? ` · ${session.branch}` : ''}
                      </p>
                      <p className="text-muted-foreground truncate text-[10px]">
                        {session.pendingPrompt || session.lastActivity}
                      </p>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </DashboardCard>

        <DashboardCard
          title="Assigned pull requests"
          description={`${items.length} pull request${items.length === 1 ? '' : 's'} assigned to you`}
          actions={
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => void refresh()}
              disabled={isLoading}
              aria-label="Refresh assigned pull requests"
              title="Refresh assigned pull requests"
            >
              <RefreshCwIcon className={cn('size-3.5', isLoading && 'animate-spin')} />
            </Button>
          }
        >
          {errors.length > 0 ? (
            <div className="border-destructive/30 bg-destructive/5 rounded-md border px-3 py-2">
              {errors.map((error) => (
                <p key={error} className="text-destructive text-xs">
                  {error}
                </p>
              ))}
            </div>
          ) : null}
          {isLoading && items.length === 0 ? (
            <div className="text-muted-foreground flex items-center gap-2 py-3 text-xs">
              <Loader2Icon className="size-3.5 animate-spin" />
              Checking configured repositories…
            </div>
          ) : items.length === 0 ? (
            <div className="text-muted-foreground flex items-center gap-2 py-3 text-xs italic">
              <GitPullRequestIcon className="size-4" />
              No pull requests are currently assigned to you.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <PullRequestRow
                  key={item.key}
                  item={item}
                  sessionAvailable={
                    !!item.review?.sessionId &&
                    sessions.some((session) => session.id === item.review?.sessionId)
                  }
                  onOpenSession={openSession}
                />
              ))}
            </ul>
          )}
          <div className="text-muted-foreground flex items-center gap-1.5 border-t pt-2 text-[10px]">
            <BotIcon className="size-3" />
            New assignments start an embedded, read-only Copilot review automatically.
          </div>
        </DashboardCard>
      </div>
    </div>
  )
}
