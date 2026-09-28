import { useId } from 'react'
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

import { nanoAiuToCredits, type CopilotAnalyticsSummary } from '@shared/copilot-analytics'
import { CHART_COLORS, chartTick, chartTooltipStyle, credits, number } from './format'

export function UsageOverTimeChart({
  summary
}: {
  summary: CopilotAnalyticsSummary
}): React.JSX.Element {
  const fillId = useId()
  const { totals } = summary
  const hasCredits = totals.creditRecords > 0

  return (
    <>
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
    </>
  )
}

export function TokenMixChart({
  summary
}: {
  summary: CopilotAnalyticsSummary
}): React.JSX.Element {
  const tokens = [
    {
      name: 'Input',
      value: summary.models.reduce((sum, model) => sum + model.inputTokens, 0)
    },
    {
      name: 'Output',
      value: summary.models.reduce((sum, model) => sum + model.outputTokens, 0)
    },
    {
      name: 'Cache read',
      value: summary.models.reduce((sum, model) => sum + model.cacheReadTokens, 0)
    },
    {
      name: 'Cache write',
      value: summary.models.reduce((sum, model) => sum + model.cacheWriteTokens, 0)
    }
  ].filter((entry) => entry.value > 0)

  if (!tokens.length) {
    return (
      <p className="flex h-64 items-center justify-center text-xs text-muted-foreground">
        No positive token counts are recorded in this selection.
      </p>
    )
  }

  return (
    <>
      <div className="h-64" role="img" aria-label="Copilot CLI token mix; exact counts below">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={tokens}
              dataKey="value"
              nameKey="name"
              innerRadius={45}
              outerRadius={72}
              paddingAngle={2}
              isAnimationActive={false}
            >
              {tokens.map((entry, index) => (
                <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value) => number(Number(value))}
              contentStyle={chartTooltipStyle}
            />
            <Legend
              verticalAlign="bottom"
              wrapperStyle={{ fontSize: 12 }}
              formatter={(label) => <span className="text-foreground">{label}</span>}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer rounded py-1 text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring">
          View token counts
        </summary>
        <ul className="divide-y">
          {tokens.map((entry) => (
            <li key={entry.name} className="flex justify-between gap-3 py-2">
              <span>{entry.name}</span>
              <span className="tabular-nums">{number(entry.value)}</span>
            </li>
          ))}
        </ul>
      </details>
    </>
  )
}

export function CostByModelChart({
  summary
}: {
  summary: CopilotAnalyticsSummary
}): React.JSX.Element {
  const costs = summary.models
    .filter((model) => model.creditRecords > 0)
    .map((model) => ({ name: model.model, credits: nanoAiuToCredits(model.costNanoAiu) }))

  if (!costs.length) {
    return (
      <p className="flex h-56 items-center justify-center text-xs text-muted-foreground">
        No CLI credit records are available in this selection.
      </p>
    )
  }

  return (
    <div
      style={{ height: Math.max(224, costs.length * 32) }}
      role="img"
      aria-label="Copilot CLI credits by model; exact amounts in the model usage table"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={costs} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
          <XAxis type="number" tick={chartTick} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="name"
            tick={chartTick}
            axisLine={false}
            tickLine={false}
            width={140}
          />
          <Tooltip
            formatter={(value) => `${credits(Number(value) * 1e11)} credits`}
            contentStyle={chartTooltipStyle}
          />
          <Bar dataKey="credits" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {costs.map((entry, index) => (
              <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
