import * as React from 'react'
import {
  AlertCircleIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  Clock3Icon,
  GitPullRequestIcon,
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
import { cn } from '@/lib/utils'
import {
  isTerminalSessionFinished,
  terminalObservationIssue,
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

export function DashboardPage({
  repositories,
  onNavigateToSessions,
  onNavigateToReviews
}: {
  repositories: Repository[]
  onNavigateToSessions: () => void
  onNavigateToReviews: () => void
}): React.JSX.Element {
  const { sessions, interactionById, interactionRequestedAtById, select, observationNow } =
    useTerminalSessions()
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
                          {terminalObservationIssue(session, observationNow) ||
                            session.pendingPrompt ||
                            session.lastActivity}
                        </p>
                      </div>
                      <span className="text-muted-foreground flex shrink-0 items-center gap-1 pt-0.5 text-[10px]">
                        Open session
                        <ArrowUpRightIcon className="size-3" />
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </DashboardCard>

        <DashboardCard
          title="Assigned reviews"
          description={
            isLoading && items.length === 0
              ? 'Checking configured repositories…'
              : `${items.length} pull request${items.length === 1 ? '' : 's'} awaiting your review`
          }
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
            <div className="border-destructive/30 bg-destructive/5 flex items-start gap-2 rounded-md border px-3 py-2">
              <AlertCircleIcon className="text-destructive mt-0.5 size-3.5 shrink-0" />
              <p className="text-destructive line-clamp-2 text-xs">{errors.join(' · ')}</p>
            </div>
          ) : null}
          <button
            type="button"
            onClick={onNavigateToReviews}
            className={cn(
              'bg-background/60 hover:bg-accent/60 focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-3'
            )}
          >
            <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
              <GitPullRequestIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium">Open Reviews</span>
              <span className="text-muted-foreground block truncate text-[10px]">
                Choose a repository to inspect assigned and recent pull requests.
              </span>
            </span>
            <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
          </button>
        </DashboardCard>
      </div>
    </div>
  )
}
