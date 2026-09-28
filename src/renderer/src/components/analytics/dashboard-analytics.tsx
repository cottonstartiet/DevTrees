import { AlertCircleIcon, RefreshCwIcon } from 'lucide-react'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useCopilotAnalytics } from '@/hooks/use-copilot-analytics'
import { cn } from '@/lib/utils'
import { CostByModelChart, TokenMixChart, UsageOverTimeChart } from './charts'

function AnalyticsLoading(): React.JSX.Element {
  return (
    <>
      <DashboardCard title="Usage over time" description="Loading the last 7 days…">
        <Skeleton className="h-60 w-full" />
      </DashboardCard>
      <div className="grid gap-4 xl:grid-cols-2">
        <DashboardCard title="Token mix" description="Loading recorded token usage…">
          <Skeleton className="h-64 w-full" />
        </DashboardCard>
        <DashboardCard title="Cost by model" description="Loading recorded CLI credits…">
          <Skeleton className="h-56 w-full" />
        </DashboardCard>
      </div>
    </>
  )
}

export function DashboardAnalytics(): React.JSX.Element {
  const { summary, error, isLoading, refresh } = useCopilotAnalytics(7)

  if (isLoading) return <AnalyticsLoading />

  if (error) {
    return (
      <DashboardCard
        title="Analytics"
        description="Copilot CLI usage for the last 7 days across all repositories."
        actions={
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            <RefreshCwIcon />
            Retry
          </Button>
        }
      >
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 flex items-start gap-2 rounded-md border px-3 py-2"
        >
          <AlertCircleIcon className="text-destructive mt-0.5 size-3.5 shrink-0" />
          <p className="text-destructive break-words text-xs">{error}</p>
        </div>
      </DashboardCard>
    )
  }

  if (!summary || summary.totals.sessions === 0) {
    return (
      <DashboardCard
        title="Analytics"
        description="Copilot CLI usage for the last 7 days across all repositories."
      >
        <p className="text-muted-foreground text-xs italic">
          No Copilot activity is recorded for this period.
        </p>
      </DashboardCard>
    )
  }

  return (
    <>
      <DashboardCard
        title="Usage over time"
        description="User turns (solid) and active sessions (dashed) over the last 7 days."
        actions={
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void refresh()}
            disabled={isLoading}
            aria-label="Refresh dashboard analytics"
            title="Refresh dashboard analytics"
          >
            <RefreshCwIcon className={cn(isLoading && 'animate-spin')} />
          </Button>
        }
      >
        <UsageOverTimeChart summary={summary} />
      </DashboardCard>
      <div className="grid gap-4 xl:grid-cols-2">
        <DashboardCard
          title="Token mix"
          description="Recorded input, output and cache token fields."
        >
          <TokenMixChart summary={summary} />
        </DashboardCard>
        <DashboardCard
          title="Cost by model"
          description="Recorded Copilot CLI AI credits per model."
        >
          <CostByModelChart summary={summary} />
        </DashboardCard>
      </div>
    </>
  )
}
