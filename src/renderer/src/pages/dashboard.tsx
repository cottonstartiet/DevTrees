import * as React from 'react'
import {
  AlertCircleIcon,
  ChevronRightIcon,
  Clock3Icon,
  CircleCheckIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  Loader2Icon,
  RefreshCwIcon
} from 'lucide-react'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { MarkdownBody } from '@/components/pr-review/markdown-body'
import { NativeSessionControls } from '@/components/sessions/session-interaction'
import {
  TERMINAL_SESSION_STATUS_ICON,
  TERMINAL_SESSION_STATUS_LABEL,
  TERMINAL_SESSION_STATUS_TONE
} from '@/components/sessions/terminal-session-status'
import { Button } from '@/components/ui/button'
import { useDashboard } from '@/contexts/dashboard-context'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import type { AutoReviewStatus } from '@/lib/auto-reviews'
import { cn } from '@/lib/utils'
import {
  isTerminalSessionFinished,
  terminalObservationIssue,
  type TerminalSession
} from '@shared/terminal-session'
import {
  nativeSessionNeedsUserAction,
  nativeSessionPresentationStatus,
  terminalSessionActivityPreview,
  type NativeInteraction
} from '@shared/native-session'
import type { Repository } from '@shared/repository'

function compareActiveSessions(a: TerminalSession, b: TerminalSession): number {
  return b.createdAt - a.createdAt
}

function interactionLabel(
  interaction: NativeInteraction | undefined,
  planTransitionAvailable: boolean
): string {
  if (!interaction)
    return planTransitionAvailable ? 'Plan reply or next step required' : 'Response requested'
  if (interaction.kind === 'permission' || interaction.kind === 'acpPermission')
    return 'Permission requested'
  return interaction.kind === 'elicitation' && interaction.url
    ? 'Link confirmation requested'
    : 'Input requested'
}

function sessionTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function autoReviewLabel(status: AutoReviewStatus): string {
  switch (status) {
    case 'checking':
      return 'Checking automation'
    case 'launching':
      return 'Starting review'
    case 'started':
      return 'Review started'
    case 'already-triggered':
      return 'Reviewed'
    case 'failed':
      return 'Start failed'
  }
}

export function DashboardPage({
  repositories,
  onNavigateToSessions,
  onNavigateToReviews
}: {
  repositories: Repository[]
  onNavigateToSessions: () => void
  onNavigateToReviews: (repositoryId?: string) => void
}): React.JSX.Element {
  const { sessions, nativeById, select, focusExternal, observationNow } = useTerminalSessions()
  const interactionById = React.useMemo(
    () =>
      Object.fromEntries(
        Object.entries(nativeById).map(([id, snapshot]) => [id, snapshot?.interactions[0]])
      ),
    [nativeById]
  )
  const interactionRequestedAtById = React.useMemo(
    () =>
      Object.fromEntries(
        Object.entries(interactionById).map(([id, request]) => [id, request?.createdAt])
      ),
    [interactionById]
  )
  const { items, errors, isLoading, refresh } = useDashboard()
  const liveSessions = React.useMemo(
    () =>
      sessions
        .filter((session) => !isTerminalSessionFinished(session.status))
        .sort(compareActiveSessions),
    [sessions]
  )
  const sessionsNeedingAction = liveSessions.filter((session) =>
    nativeSessionNeedsUserAction(session, nativeById[session.id])
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
            liveSessions.length > 0 ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {liveSessions.length} Copilot session{liveSessions.length === 1 ? '' : 's'}{' '}
                  running
                </span>
                {sessionsNeedingAction > 0 ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-foreground font-medium">
                      {sessionsNeedingAction} need{sessionsNeedingAction === 1 ? 's' : ''} your
                      action
                    </span>
                  </>
                ) : null}
              </span>
            ) : null
          }
        >
          {liveSessions.length === 0 ? (
            <p className="text-muted-foreground text-xs italic">No Copilot sessions are running.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {liveSessions.map((session) => {
                const interaction = interactionById[session.id]
                const snapshot = nativeById[session.id]
                const planTransitionAvailable = Boolean(
                  snapshot?.session.generation === session.generation &&
                  snapshot?.planTransitionAvailable
                )
                const needsAction = nativeSessionNeedsUserAction(session, snapshot)
                const presentationStatus = nativeSessionPresentationStatus(session, snapshot)
                const observationIssue = terminalObservationIssue(session, observationNow)
                const activityPreview = terminalSessionActivityPreview(
                  session,
                  snapshot,
                  observationIssue
                )
                const StatusIcon = TERMINAL_SESSION_STATUS_ICON[presentationStatus]
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
                      onClick={() =>
                        session.transport === 'external'
                          ? void focusExternal(session.id)
                          : openSession(session.id)
                      }
                      title={
                        session.transport === 'external'
                          ? `Focus terminal for ${session.label}`
                          : `Open ${session.label}`
                      }
                      aria-label={
                        session.transport === 'external'
                          ? `Focus terminal for ${session.label}`
                          : `Open ${session.label} in Sessions`
                      }
                      className={cn(
                        'hover:bg-accent/60 focus-visible:ring-ring/50 flex w-full items-start gap-3 p-3 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-3'
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            'flex size-6 shrink-0 items-center justify-center rounded-md',
                            TERMINAL_SESSION_STATUS_TONE[presentationStatus]
                          )}
                        >
                          <StatusIcon
                            className={cn(
                              'size-3.5',
                              presentationStatus === 'working' && 'animate-spin'
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
                              TERMINAL_SESSION_STATUS_TONE[presentationStatus]
                            )}
                          >
                            {TERMINAL_SESSION_STATUS_LABEL[presentationStatus]}
                          </span>
                          {needsAction ? (
                            <span className="text-foreground flex items-center gap-1 text-[10px] font-medium">
                              <Clock3Icon className="size-3" />
                              {interactionLabel(interaction, planTransitionAvailable)} at{' '}
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
                      </div>
                      {session.transport === 'external' ? (
                        <ExternalLinkIcon
                          aria-hidden="true"
                          className="text-muted-foreground size-3.5 shrink-0"
                        />
                      ) : (
                        <ChevronRightIcon
                          aria-hidden="true"
                          className="text-muted-foreground size-3.5 shrink-0"
                        />
                      )}
                    </button>
                    <div className="border-t px-3 py-3">
                      {activityPreview.markdown ? (
                        <MarkdownBody text={activityPreview.text} />
                      ) : (
                        <p
                          className={cn(
                            'whitespace-pre-wrap break-words text-xs leading-relaxed',
                            needsAction ? 'text-foreground' : 'text-muted-foreground'
                          )}
                        >
                          {activityPreview.text}
                        </p>
                      )}
                    </div>
                    {session.transport !== 'external' && (
                      <NativeSessionControls
                        session={session}
                        compact
                        showComposer={false}
                        onOpenSession={(requestId) => {
                          select(session.id, requestId)
                          onNavigateToSessions()
                        }}
                      />
                    )}
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
          {items.length === 0 ? (
            <button
              type="button"
              onClick={() => onNavigateToReviews()}
              className={cn(
                'bg-background/60 hover:bg-accent/60 focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-3'
              )}
            >
              <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
                <GitPullRequestIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">No assigned reviews</span>
                <span className="text-muted-foreground block truncate text-[10px]">
                  Open Reviews to inspect recent pull requests.
                </span>
              </span>
              <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
            </button>
          ) : (
            <div className="bg-background/60 overflow-hidden rounded-md border">
              <ul className="divide-y">
                {items.map((item) => {
                  const isPending =
                    item.autoReviewStatus === 'checking' || item.autoReviewStatus === 'launching'
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={() => onNavigateToReviews(item.repository.id)}
                        className="hover:bg-accent/60 focus-visible:ring-ring/50 flex w-full items-center gap-3 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-3"
                      >
                        <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]">
                          #{item.pr.id}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">
                            {item.pr.title}
                          </span>
                          <span className="text-muted-foreground block truncate text-[10px]">
                            {item.repository.name} · {item.pr.sourceRef} → {item.pr.targetRef}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'text-muted-foreground flex shrink-0 items-center gap-1 text-[10px]',
                            item.autoReviewStatus === 'failed' && 'text-destructive'
                          )}
                        >
                          {isPending ? (
                            <Loader2Icon className="size-3 animate-spin" />
                          ) : item.autoReviewStatus === 'started' ||
                            item.autoReviewStatus === 'already-triggered' ? (
                            <CircleCheckIcon className="size-3" />
                          ) : null}
                          {autoReviewLabel(item.autoReviewStatus)}
                        </span>
                        <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                      </button>
                    </li>
                  )
                })}
              </ul>
              <button
                type="button"
                onClick={() => onNavigateToReviews()}
                className="text-muted-foreground hover:bg-accent/60 focus-visible:ring-ring/50 flex w-full items-center justify-center gap-1 border-t px-3 py-2 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-3"
              >
                Open all reviews
                <ChevronRightIcon className="size-3" />
              </button>
            </div>
          )}
        </DashboardCard>
      </div>
    </div>
  )
}
