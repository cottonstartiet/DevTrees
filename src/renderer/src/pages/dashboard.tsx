import * as React from 'react'
import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDotIcon,
  GitPullRequestIcon,
  Loader2Icon,
  RefreshCwIcon,
  TerminalIcon
} from 'lucide-react'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { Button } from '@/components/ui/button'
import { useDashboard } from '@/contexts/dashboard-context'
import { useSessions } from '@/contexts/sessions-context'
import {
  type DashboardAssignedPr,
  type DashboardReviewState
} from '@/hooks/use-dashboard-pr-reviews'
import { cn } from '@/lib/utils'
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
            onClick={() => onOpenSession(review.sessionId!)}
          >
            Session
            <ChevronRightIcon className="size-3" />
          </Button>
        ) : null}
      </div>
      {review?.state === 'completed' || review?.state === 'error' ? (
        <details className="border-t px-3 py-2">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-[10px] font-medium">
            Review details
          </summary>
          {review.error ? <p className="text-destructive mt-2 text-xs">{review.error}</p> : null}
          {review.output ? (
            <pre className="bg-muted/60 mt-2 max-h-72 overflow-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {review.output}
            </pre>
          ) : (
            <p className="text-muted-foreground mt-2 text-xs italic">
              No review output was captured.
            </p>
          )}
        </details>
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
  const { sessions, activityBySessionId, selectSession } = useSessions()
  const { items, errors, isLoading, refresh } = useDashboard()
  const waitingSessions = sessions.filter(
    (session) =>
      session.status === 'running' && activityBySessionId[session.id]?.waitingForInput === true
  )

  const openSession = React.useCallback(
    (sessionId: string): void => {
      selectSession(sessionId)
      onNavigateToSessions()
    },
    [onNavigateToSessions, selectSession]
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold tracking-tight">System activity</h3>
          <p className="text-muted-foreground text-xs">
            Attention and review work across {repositories.length}{' '}
            {repositories.length === 1 ? 'repository' : 'repositories'}.
          </p>
        </div>

        <DashboardCard
          title="Sessions awaiting input"
          description={`${waitingSessions.length} session${waitingSessions.length === 1 ? '' : 's'} need attention`}
        >
          {waitingSessions.length === 0 ? (
            <p className="text-muted-foreground text-xs italic">
              No embedded Copilot sessions are waiting for input.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {waitingSessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => openSession(session.id)}
                    className={cn(
                      'bg-background/60 hover:bg-accent/60 focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-3'
                    )}
                  >
                    <CircleDotIcon className="size-3.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{session.label}</p>
                      <p className="text-muted-foreground truncate font-mono text-[10px]">
                        {activityBySessionId[session.id]?.lastLine || session.folderPath}
                      </p>
                    </div>
                    <TerminalIcon className="text-muted-foreground size-3.5 shrink-0" />
                    <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
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
