import * as React from 'react'
import {
  AlertCircleIcon,
  ArrowUpRightIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  Clock3Icon,
  GitPullRequestIcon,
  Loader2Icon,
  RefreshCwIcon
} from 'lucide-react'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { SessionInteraction } from '@/components/sessions/session-interaction'
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
import {
  isTerminalSessionFinished,
  type TerminalSession,
  type TerminalSessionInteraction
} from '@shared/terminal-session'
import type { Repository } from '@shared/repository'

function needsUserAction(
  session: TerminalSession,
  interaction?: TerminalSessionInteraction
): boolean {
  return session.status === 'waiting-input' || Boolean(interaction)
}

function compareActiveSessions(
  interactionById: Record<string, TerminalSessionInteraction | undefined>,
  interactionRequestedAtById: Record<string, number | undefined>
): (a: TerminalSession, b: TerminalSession) => number {
  return (a, b) => {
    const aNeedsAction = needsUserAction(a, interactionById[a.id])
    const bNeedsAction = needsUserAction(b, interactionById[b.id])

    if (aNeedsAction !== bNeedsAction) return aNeedsAction ? -1 : 1
    if (aNeedsAction) {
      const aRequestedAt = interactionRequestedAtById[a.id] ?? a.updatedAt
      const bRequestedAt = interactionRequestedAtById[b.id] ?? b.updatedAt
      return aRequestedAt - bRequestedAt
    }
    return b.updatedAt - a.updatedAt
  }
}

function interactionLabel(interaction?: TerminalSessionInteraction): string {
  if (!interaction) return 'Response requested'
  if (interaction.kind === 'permission') return 'Permission requested'
  return interaction.mode === 'url' ? 'Link confirmation requested' : 'Input requested'
}

function sessionTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

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
  const { sessions, interactionById, interactionRequestedAtById, select } = useTerminalSessions()
  const { items, errors, isLoading, refresh } = useDashboard()
  const liveSessions = React.useMemo(
    () =>
      sessions
        .filter((session) => !isTerminalSessionFinished(session.status))
        .sort(compareActiveSessions(interactionById, interactionRequestedAtById)),
    [interactionById, interactionRequestedAtById, sessions]
  )
  const sessionsNeedingAction = liveSessions.filter((session) =>
    needsUserAction(session, interactionById[session.id])
  ).length

  const openSession = React.useCallback(
    (sessionId: string): void => {
      select(sessionId)
      onNavigateToSessions()
    },
    [onNavigateToSessions, select]
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold tracking-tight">Activity</h3>
          <p className="text-muted-foreground text-xs">
            Attention and review work across {repositories.length}{' '}
            {repositories.length === 1 ? 'repository' : 'repositories'}.
          </p>
        </div>

        <DashboardCard
          title="Active sessions"
          description={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>
                {liveSessions.length} Copilot session{liveSessions.length === 1 ? '' : 's'} running
              </span>
              {sessionsNeedingAction > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-foreground font-medium">
                    {sessionsNeedingAction} need{sessionsNeedingAction === 1 ? 's' : ''} your input
                  </span>
                </>
              ) : null}
            </span>
          }
        >
          {liveSessions.length === 0 ? (
            <p className="text-muted-foreground text-xs italic">No Copilot sessions are running.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {liveSessions.map((session) => {
                const StatusIcon = TERMINAL_SESSION_STATUS_ICON[session.status]
                const interaction = interactionById[session.id]
                const needsAction = needsUserAction(session, interaction)
                return (
                  <div
                    key={session.id}
                    className={cn(
                      'bg-background/60 overflow-hidden rounded-md border',
                      needsAction && 'border-amber-500/35 bg-amber-500/[0.035]'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => openSession(session.id)}
                      className={cn(
                        'hover:bg-accent/60 focus-visible:ring-ring/50 flex w-full items-start gap-3 p-3 text-left transition-colors',
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
                            className={cn(
                              'size-3.5',
                              session.status === 'working' && 'animate-spin'
                            )}
                          />
                        </span>
                      </div>
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-sm font-medium">{session.label}</span>
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10px] font-medium',
                              TERMINAL_SESSION_STATUS_TONE[session.status]
                            )}
                          >
                            {TERMINAL_SESSION_STATUS_LABEL[session.status]}
                          </span>
                          {needsAction ? (
                            <span className="text-foreground flex items-center gap-1 text-[10px] font-medium">
                              <Clock3Icon className="size-3" />
                              {interactionLabel(interaction)} at{' '}
                              {sessionTime(
                                interactionRequestedAtById[session.id] ?? session.updatedAt
                              )}
                            </span>
                          ) : null}
                        </div>
                        {(session.repository || session.branch) && (
                          <p className="text-muted-foreground truncate font-mono text-[10px]">
                            {[session.repository, session.branch].filter(Boolean).join(' · ')}
                          </p>
                        )}
                        <p
                          className={cn(
                            'text-xs leading-relaxed',
                            needsAction ? 'text-foreground' : 'text-muted-foreground'
                          )}
                        >
                          {session.pendingPrompt || session.lastActivity}
                        </p>
                      </div>
                      <span className="text-muted-foreground flex shrink-0 items-center gap-1 pt-0.5 text-[10px]">
                        Open session
                        <ArrowUpRightIcon className="size-3" />
                      </span>
                    </button>
                    {needsAction && interaction ? (
                      <div className="bg-card border-t px-3 py-3">
                        <SessionInteraction
                          key={interaction.requestId}
                          session={session}
                          interaction={interaction}
                          onOpenSession={() => openSession(session.id)}
                        />
                      </div>
                    ) : session.status === 'idle' || session.status === 'waiting-input' ? (
                      <SessionInteraction
                        key="composer"
                        session={session}
                        compact
                        onOpenSession={() => openSession(session.id)}
                      />
                    ) : null}
                  </div>
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
