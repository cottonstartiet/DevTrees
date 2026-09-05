import * as React from 'react'
import { AlertCircleIcon, ChevronRightIcon, GitPullRequestIcon, RefreshCwIcon } from 'lucide-react'

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
import type { Repository } from '@shared/repository'
import { isTerminalSessionFinished } from '@shared/terminal-session'

export function DashboardPage({
  repositories,
  onNavigateToSessions,
  onNavigateToReviews
}: {
  repositories: Repository[]
  onNavigateToSessions: () => void
  onNavigateToReviews: () => void
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
