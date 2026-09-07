import {
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

import { nanoAiuToCredits } from '@shared/copilot-analytics'
import type { CopilotAnalyticsSummary } from '@shared/copilot-analytics'
import { CHART_COLORS, chartTick, chartTooltipStyle, credits, number } from './format'
import { Section } from './shared'

export function UsageBreakdowns({
  summary
}: {
  summary: CopilotAnalyticsSummary
}): React.JSX.Element {
  const costs = summary.models
    .filter((model) => model.creditRecords > 0)
    .map((model) => ({ name: model.model, credits: nanoAiuToCredits(model.costNanoAiu) }))
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {summary.coverage.sources.map(({ source }) => {
        const models = summary.models
        const tokens = [
          { name: 'Input', value: models.reduce((sum, model) => sum + model.inputTokens, 0) },
          { name: 'Output', value: models.reduce((sum, model) => sum + model.outputTokens, 0) },
          {
            name: 'Cache read',
            value: models.reduce((sum, model) => sum + model.cacheReadTokens, 0)
          },
          {
            name: 'Cache write',
            value: models.reduce((sum, model) => sum + model.cacheWriteTokens, 0)
          }
        ].filter((entry) => entry.value > 0)
        return (
          <Section
            key={source}
            title="Token mix"
            description="Recorded input, output and cache token fields."
          >
            {tokens.length ? (
              <>
                <div
                  className="h-64"
                  role="img"
                  aria-label="Copilot CLI token mix; exact counts below"
                >
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
            ) : (
              <p className="flex h-64 items-center justify-center text-xs text-muted-foreground">
                No positive token counts are recorded in this selection.
              </p>
            )}
          </Section>
        )
      })}
      <Section title="Cost by model" description="Recorded Copilot CLI AI credits per model.">
        {costs.length ? (
          <>
            <div
              style={{ height: Math.max(224, costs.length * 32) }}
              role="img"
              aria-label="Copilot CLI credits by model; exact amounts in the model usage table"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={costs} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--color-border)"
                    horizontal={false}
                  />
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
          </>
        ) : (
          <p className="flex h-56 items-center justify-center text-xs text-muted-foreground">
            No CLI credit records are available in this selection.
          </p>
        )}
      </Section>
    </div>
  )
}
