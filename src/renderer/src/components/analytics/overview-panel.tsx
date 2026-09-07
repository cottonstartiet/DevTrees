import { useId } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'

import type { CopilotAnalyticsSummary } from '@shared/copilot-analytics'
import { baseName } from '@/lib/utils'
import { UsageBreakdowns } from './usage-breakdowns'
import {
  change,
  chartTick,
  chartTooltipStyle,
  credits,
  duration,
  number,
  ratio,
  SOURCE_LABELS
} from './format'
import { Explanation, Metric, Section } from './shared'

export function OverviewPanel({
  summary
}: {
  summary: CopilotAnalyticsSummary
}): React.JSX.Element {
  const { totals, previous, coverage } = summary
  const hasCredits = totals.creditRecords > 0
  const fillId = useId()
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-y px-1 py-2 md:grid-cols-3 xl:grid-cols-6">
        <Metric
          label="Sessions"
          value={number(totals.sessions)}
          hint={change(totals.sessions, previous.sessions)}
        />
        <Metric
          label="User turns"
          value={number(totals.turns)}
          hint={change(totals.turns, previous.turns)}
        />
        <Metric
          label="Active days"
          value={`${totals.activeDays} / ${summary.windowDays}`}
          hint={change(totals.activeDays, previous.activeDays)}
        />
        <Metric
          label="Recorded CLI credits"
          value={hasCredits ? credits(totals.costNanoAiu) : 'Unavailable'}
          hint={
            hasCredits && previous.creditRecords > 0
              ? change(totals.costNanoAiu, previous.costNanoAiu)
              : 'No recorded credit baseline for comparison'
          }
        />
        <Metric
          label="Turns per session"
          value={totals.sessions ? number(totals.turns / totals.sessions) : 'Unavailable'}
          hint="Sessions with activity in this window"
        />
        <Metric
          label="Distinct files touched"
          value={coverage.filesAvailable ? number(totals.uniqueFiles) : 'Unavailable'}
          hint={`${number(totals.filesCreated)} create / ${number(totals.filesEdited)} edit records`}
        />
      </div>

      <Section
        title="Usage over time"
        description="User turns (solid) and active sessions (dashed). Model calls are separate usage records, not extra user turns."
      >
        <div
          className="h-60"
          role="img"
          aria-label={`Daily activity: ${totals.turns} turns across ${totals.activeDays} active days`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={summary.daily} margin={{ left: -16, right: 12, top: 8 }}>
              <defs>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis
                dataKey="date"
                tick={chartTick}
                tickFormatter={(value: string) => value.slice(5)}
                minTickGap={30}
                axisLine={false}
                tickLine={false}
              />
              <YAxis tick={chartTick} allowDecimals={false} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={chartTooltipStyle} />
              <Area
                type="monotone"
                dataKey="turns"
                name="User turns"
                stroke="var(--color-chart-1)"
                fill={`url(#${fillId})`}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="sessions"
                name="Sessions"
                stroke="var(--color-chart-2)"
                fill="transparent"
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <details className="text-xs">
          <summary className="cursor-pointer rounded py-1 text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring">
            View daily data
          </summary>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left tabular-nums">
              <thead>
                <tr className="border-b">
                  <th className="py-2">Date</th>
                  <th>Turns</th>
                  <th>Sessions</th>
                  <th>Recorded CLI credits</th>
                </tr>
              </thead>
              <tbody>
                {summary.daily.map((day) => (
                  <tr key={day.date} className="border-b last:border-0">
                    <td className="py-2">{day.date}</td>
                    <td>{number(day.turns)}</td>
                    <td>{day.sessions}</td>
                    <td>{hasCredits ? credits(day.costNanoAiu) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Section>

      <UsageBreakdowns summary={summary} />

      <Section
        title="Data coverage"
        description="Missing records are not zero usage. Model calls are usage records, separate from user turns."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs tabular-nums">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 font-medium">Source</th>
                <th className="font-medium">Sessions with records</th>
                <th className="font-medium">Input + output present</th>
                <th className="font-medium">Credits present</th>
                <th className="font-medium">Recorded latency</th>
              </tr>
            </thead>
            <tbody>
              {coverage.sources.map((source) => (
                <tr key={source.source} className="border-b last:border-0">
                  <td className="py-3 font-medium">{SOURCE_LABELS[source.source]}</td>
                  <td>
                    {source.sessionsWithUsage} / {source.sessions}
                  </td>
                  <td>
                    {source.tokenRecords} / {source.usageRecords} (
                    {ratio(source.tokenRecords, source.usageRecords)})
                  </td>
                  <td>
                    {source.creditRecords} / {source.usageRecords}
                  </td>
                  <td>
                    {duration(source.avgResponseMs)}
                    <span className="block text-muted-foreground">per model call</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="max-w-[90ch] text-xs leading-relaxed text-muted-foreground">
          Values come from saved Copilot CLI records, not an invoice or a complete account-wide
          usage history. Missing fields, deleted sessions and histories on other machines are not
          reconstructed. Coverage can differ between the current and previous periods.
        </p>
      </Section>

      <Section
        title="Models and recorded usage"
        description="Recorded model calls, ordered by credits and then usage volume."
        actions={
          <Explanation text="Tokens and credits come directly from saved CLI usage records. No guessed costs or savings are applied. Model dominance measures volume, not whether a model was the right choice." />
        }
      >
        {summary.models.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-xs tabular-nums">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  {[
                    'Model / source',
                    'Records',
                    'Input',
                    'Output',
                    'Cache read',
                    'Cache write',
                    'Credits'
                  ].map((title) => (
                    <th key={title} className="py-2 font-medium">
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.models.map((model) => (
                  <tr key={`${model.source}:${model.model}`} className="border-b last:border-0">
                    <td className="max-w-64 break-words py-3 pr-3 font-medium">
                      {model.model}
                      <span className="block font-normal text-muted-foreground">
                        {SOURCE_LABELS[model.source]}
                      </span>
                    </td>
                    <td>{number(model.events)}</td>
                    <td title={`${model.inputRecords} of ${model.events} records`}>
                      {model.inputRecords ? number(model.inputTokens) : '-'}
                    </td>
                    <td title={`${model.outputRecords} of ${model.events} records`}>
                      {model.outputRecords ? number(model.outputTokens) : '-'}
                    </td>
                    <td>{number(model.cacheReadTokens)}</td>
                    <td>{number(model.cacheWriteTokens)}</td>
                    <td>{model.creditRecords ? credits(model.costNanoAiu) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No model records are available for this selection.
          </p>
        )}
        <div className="grid grid-cols-2 gap-4 border-t pt-2 md:grid-cols-4">
          <Metric
            label="Median recorded latency"
            value={duration(totals.p50ResponseMs)}
            hint="50th percentile of recorded model-call timings"
          />
          <Metric
            label="95th percentile latency"
            value={duration(totals.p95ResponseMs)}
            hint="Nearest-rank percentile of nonnegative timings"
          />
          <Metric
            label="CLI time to first token"
            value={duration(totals.avgTimeToFirstTokenMs)}
            hint="Average across calls with first-token timing"
          />
          <Metric
            label="Recorded credits / session"
            value={
              hasCredits && totals.sessions
                ? credits(totals.costNanoAiu / totals.sessions)
                : 'Unavailable'
            }
            hint="Recorded credits divided by active sessions"
          />
        </div>
      </Section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section
          title="Repositories"
          description="Top 15 by recorded CLI credits, then user turns. Unresolved workspaces keep their own identity."
        >
          <ul className="divide-y">
            {summary.topRepositories.map((repo) => (
              <li
                key={repo.repository}
                className="flex items-start justify-between gap-4 py-2 text-xs"
              >
                <span className="min-w-0 break-all" title={repo.repository}>
                  {repo.repository}
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  {repo.sessions} sessions / {repo.turns} turns
                  {hasCredits ? (
                    <span className="block text-muted-foreground">
                      {credits(repo.costNanoAiu)} recorded cr
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Section>
        <Section
          title="File activity"
          description="Top 15 source-recorded file touches, not every edit operation or retained lines of code."
        >
          {summary.topFiles.length ? (
            <ul className="divide-y">
              {summary.topFiles.map((file) => (
                <li
                  key={`${file.repository}:${file.path}`}
                  className="flex items-start justify-between gap-4 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <span className="block break-all font-mono" title={file.path}>
                      {baseName(file.path)}
                    </span>
                    <span className="block break-all text-muted-foreground">{file.repository}</span>
                  </div>
                  <span className="shrink-0 tabular-nums">
                    {file.creates} create / {file.edits} edit
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              No file records are available for this selection.
            </p>
          )}
        </Section>
      </div>
    </div>
  )
}
