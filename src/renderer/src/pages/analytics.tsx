import * as React from 'react'
import {
  AlertTriangleIcon,
  ClockIcon,
  CoinsIcon,
  FileEditIcon,
  FlameIcon,
  GaugeIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  TimerIcon
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { toast } from 'sonner'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useCopilotAnalytics } from '@/hooks/use-copilot-analytics'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { baseName, cn } from '@/lib/utils'
import { nanoAiuToCredits } from '@shared/copilot-analytics'
import type { Repository } from '@shared/repository'

const WINDOW_OPTIONS: { value: number; label: string }[] = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' }
]

/** Insight commands run inside a Copilot terminal session, targeting whichever repository the
 *  user picks below. Each analyzes recorded session history rather than the current codebase. */
const INSIGHT_COMMANDS: { command: string; label: string; description: string }[] = [
  {
    command: '/chronicle tips',
    label: 'Usage tips',
    description: 'Personalized suggestions from your recent sessions.'
  },
  {
    command: '/chronicle cost-tips',
    label: 'Cost tips',
    description: 'Ways to cut token usage and AI-credit spend.'
  },
  {
    command: '/chronicle standup',
    label: 'Standup summary',
    description: 'What you worked on recently, summarized.'
  },
  {
    command: '/usage',
    label: 'Session usage',
    description: 'Live AI-credit and token usage for a new session.'
  },
  {
    command: '/context',
    label: 'Context breakdown',
    description: 'Context-window token usage by source.'
  }
]

const CHART_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)'
]

function formatCredits(nanoAiu: number): string {
  const credits = nanoAiuToCredits(nanoAiu)
  if (credits === 0) return '0'
  if (credits < 0.01) return '<0.01'
  return credits.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function formatMs(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint
}: {
  icon: typeof GaugeIcon
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="bg-card text-card-foreground flex flex-col gap-1 rounded-lg border p-3 shadow-sm">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint ? <div className="text-muted-foreground text-xs">{hint}</div> : null}
    </div>
  )
}

function EmptyChart({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="text-muted-foreground flex h-full min-h-[160px] items-center justify-center text-xs italic">
      {label}
    </div>
  )
}

export function AnalyticsPage({
  repositories
}: {
  repositories: Repository[]
}): React.JSX.Element {
  const { summary, error, isLoading, windowDays, setWindowDays, refresh } = useCopilotAnalytics(30)
  const launchCopilot = useCopilotLauncher()
  const [selectedRepoId, setSelectedRepoId] = React.useState<string>('')

  const targetRepo =
    repositories.find((r) => r.id === selectedRepoId) ?? repositories[0] ?? null
  const targetRepoId = targetRepo?.id ?? ''

  const runInsightCommand = React.useCallback(
    async (command: string): Promise<void> => {
      if (!targetRepo) {
        toast.error('Add a repository first to run insight commands.')
        return
      }
      const result = await launchCopilot({
        folderPath: targetRepo.path,
        prompt: command,
        label: `${command} — ${baseName(targetRepo.path)}`,
        repository: targetRepo.name
      })
      if (!result.ok) toast.error(result.error)
    },
    [launchCopilot, targetRepo]
  )

  const totals = summary?.totals ?? null
  const daily = summary?.daily ?? []
  const models = summary?.models ?? []
  const topRepositories = summary?.topRepositories ?? []
  const topFiles = summary?.topFiles ?? []

  const dailyChartData = daily.map((d) => ({
    date: formatShortDate(d.date),
    requests: d.events,
    credits: Number(nanoAiuToCredits(d.costNanoAiu).toFixed(3))
  }))

  const modelChartData = models.map((m) => ({
    name: m.model,
    credits: Number(nanoAiuToCredits(m.costNanoAiu).toFixed(3)),
    events: m.events
  }))

  const tokenBreakdown = totals
    ? [
        { name: 'Input', value: totals.inputTokens },
        { name: 'Output', value: totals.outputTokens },
        { name: 'Cache read', value: totals.cacheReadTokens },
        { name: 'Cache write', value: totals.cacheWriteTokens }
      ].filter((d) => d.value > 0)
    : []

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-full border p-0.5">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setWindowDays(opt.value)}
                aria-pressed={windowDays === opt.value}
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs transition-colors',
                  windowDays === opt.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => void refresh()}
            title="Refresh"
            aria-label="Refresh analytics"
            className="ml-auto"
          >
            <RefreshCwIcon className={cn(isLoading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangleIcon className="size-10 opacity-40" />
          <div className="space-y-1">
            <p className="text-foreground text-sm font-medium">Couldn&apos;t read Copilot usage</p>
            <p className="text-xs">{error}</p>
          </div>
        </div>
      ) : isLoading && !summary ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
          Loading…
        </div>
      ) : !summary || totals === null || totals.sessions === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <GaugeIcon className="size-10 opacity-40" />
          <div className="space-y-1">
            <p className="text-foreground text-sm font-medium">No Copilot activity yet</p>
            <p className="text-xs">
              Usage analytics appear once you&apos;ve run Copilot sessions from DevTrees or any
              terminal.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard icon={SquareTerminalIcon} label="Sessions" value={totals.sessions.toLocaleString()} />
            <StatCard icon={FlameIcon} label="Requests" value={totals.turns.toLocaleString()} />
            <StatCard
              icon={ClockIcon}
              label="Active days"
              value={`${totals.activeDays}/${windowDays}`}
            />
            <StatCard
              icon={CoinsIcon}
              label="AI credits"
              value={formatCredits(totals.costNanoAiu)}
              hint={`≈ $${(nanoAiuToCredits(totals.costNanoAiu) * 0.01).toFixed(2)}`}
            />
            <StatCard
              icon={TimerIcon}
              label="Avg response"
              value={formatMs(totals.avgResponseMs)}
              hint={
                totals.avgTimeToFirstTokenMs !== null
                  ? `${formatMs(totals.avgTimeToFirstTokenMs)} to first token`
                  : undefined
              }
            />
            <StatCard
              icon={FileEditIcon}
              label="Files touched"
              value={(totals.filesCreated + totals.filesEdited).toLocaleString()}
              hint={`${totals.filesCreated} created · ${totals.filesEdited} edited`}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
            <DashboardCard title="Usage over time" className="xl:col-span-2">
              <div className="h-64">
                {dailyChartData.length === 0 ? (
                  <EmptyChart label="No requests recorded in this window." />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={dailyChartData} margin={{ left: -20, right: 8, top: 8 }}>
                      <defs>
                        <linearGradient id="requestsFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
                        tickLine={false}
                        axisLine={false}
                        minTickGap={24}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
                        tickLine={false}
                        axisLine={false}
                        width={36}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--color-popover)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 8,
                          fontSize: 12
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="requests"
                        name="Requests"
                        stroke="var(--color-chart-1)"
                        fill="url(#requestsFill)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </DashboardCard>

            <DashboardCard title="Token mix" description="Input vs. output vs. cached tokens">
              <div className="h-64">
                {tokenBreakdown.length === 0 ? (
                  <EmptyChart label="No token data yet." />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={tokenBreakdown}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={45}
                        outerRadius={72}
                        paddingAngle={2}
                      >
                        {tokenBreakdown.map((entry, i) => (
                          <Cell key={entry.name} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value) => formatTokens(Number(value))}
                        contentStyle={{
                          background: 'var(--color-popover)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 8,
                          fontSize: 12
                        }}
                      />
                      <Legend
                        verticalAlign="bottom"
                        height={24}
                        wrapperStyle={{ fontSize: 11, color: 'var(--color-muted-foreground)' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </DashboardCard>
          </div>

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
            <DashboardCard
              title="Cost by model"
              description="AI credits spent per model in this window"
              className="xl:col-span-2"
            >
              <div className="h-56">
                {modelChartData.length === 0 ? (
                  <EmptyChart label="No model usage recorded." />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={modelChartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
                      <XAxis
                        type="number"
                        tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
                        tickLine={false}
                        axisLine={false}
                        width={110}
                      />
                      <Tooltip
                        formatter={(value) => `${value} credits`}
                        contentStyle={{
                          background: 'var(--color-popover)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 8,
                          fontSize: 12
                        }}
                      />
                      <Bar dataKey="credits" radius={[0, 4, 4, 0]}>
                        {modelChartData.map((entry, i) => (
                          <Cell key={entry.name} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </DashboardCard>

            <DashboardCard title="Top repositories" description="By AI-credit spend">
              {topRepositories.length === 0 ? (
                <p className="text-muted-foreground text-xs italic">No repository usage yet.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {topRepositories.slice(0, 6).map((r) => (
                    <li key={r.repository} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate" title={r.repository}>
                        {baseName(r.repository)}
                      </span>
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {formatCredits(r.costNanoAiu)} cr
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </DashboardCard>
          </div>

          <DashboardCard title="Most-touched files" description="Created or edited by Copilot in this window">
            {topFiles.length === 0 ? (
              <p className="text-muted-foreground text-xs italic">No file activity recorded.</p>
            ) : (
              <ul className="divide-y">
                {topFiles.map((f) => (
                  <li key={f.path} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                    <span className="truncate font-mono" title={f.path}>
                      {baseName(f.path)}
                    </span>
                    <span className="text-muted-foreground shrink-0">
                      {f.creates > 0 ? `${f.creates} created` : null}
                      {f.creates > 0 && f.edits > 0 ? ' · ' : null}
                      {f.edits > 0 ? `${f.edits} edited` : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </DashboardCard>

          <DashboardCard
            title="Insights & commands"
            description="Run Copilot's built-in analysis commands for a deeper look at your usage"
            actions={
              repositories.length > 0 ? (
                <Select value={targetRepoId} onValueChange={setSelectedRepoId}>
                  <SelectTrigger size="sm" className="w-44">
                    <SelectValue placeholder="Repository" />
                  </SelectTrigger>
                  <SelectContent>
                    {repositories.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : undefined
            }
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {INSIGHT_COMMANDS.map((cmd) => (
                <button
                  key={cmd.command}
                  type="button"
                  onClick={() => void runInsightCommand(cmd.command)}
                  disabled={!targetRepo}
                  className={cn(
                    'flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors',
                    'hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50'
                  )}
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <SquareTerminalIcon className="size-3.5" />
                    {cmd.label}
                  </span>
                  <span className="text-muted-foreground text-xs">{cmd.description}</span>
                  <code className="text-muted-foreground mt-0.5 text-[10px]">{cmd.command}</code>
                </button>
              ))}
            </div>
          </DashboardCard>
        </div>
      )}
    </div>
  )
}
