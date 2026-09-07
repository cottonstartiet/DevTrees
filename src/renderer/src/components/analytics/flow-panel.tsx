import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis
} from 'recharts'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { CopilotAnalyticsSummary } from '@shared/copilot-analytics'
import { Explanation, Metric, Section } from './shared'
import { CHART_COLORS, chartTick, chartTooltipStyle, number, ratio } from './format'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function heatColor(value: number, max: number): string {
  const intensity = value > 0 ? 25 + Math.ceil((value / Math.max(1, max)) * 4) * 18.75 : 0
  return `color-mix(in oklch, var(--color-chart-2) ${intensity}%, var(--color-card))`
}

function HeatLegend({ max }: { max: number }): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      aria-label={`Activity scale: 0 to ${max} turns`}
    >
      <span>0 turns</span>
      {[0, 0.25, 0.5, 0.75, 1].map((value) => (
        <span
          key={value}
          aria-hidden="true"
          className="size-3 rounded-sm border"
          style={{ background: heatColor(value, 1) }}
        />
      ))}
      <span>{max} turns</span>
    </div>
  )
}

function IntensityCell({
  value,
  max,
  label
}: {
  value: number
  max: number
  label: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="h-7 min-w-6 rounded-sm border border-border text-[10px] tabular-nums focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
          style={{
            background: heatColor(value, max)
          }}
        >
          <span className="sr-only">{value} turns</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function FlowPanel({ summary }: { summary: CopilotAnalyticsSummary }): React.JSX.Element {
  const { current, previous, heatmap, peakHour, tips } = summary.flow
  const max = Math.max(0, ...heatmap.map((cell) => cell.turns))
  const maxDaily = Math.max(0, ...summary.daily.map((day) => day.turns))
  const firstWeekday = new Date(`${summary.fromDate}T12:00:00`).getDay()
  const weekdays = DAYS.map((day, weekday) => ({
    day,
    weekend: weekday === 0 || weekday === 6,
    turns: heatmap
      .filter((cell) => cell.weekday === weekday)
      .reduce((sum, cell) => sum + cell.turns, 0)
  }))
  return (
    <div className="space-y-4">
      <p className="max-w-[90ch] text-xs leading-relaxed text-muted-foreground">
        This view describes recorded prompt cadence in this computer&apos;s local timezone, not
        attention, hours worked or health. Long gaps can mean reviewing code, running an agent or
        stepping away. All streaks are limited to the selected window.
      </p>
      <div className="grid grid-cols-2 gap-4 border-y py-2 lg:grid-cols-4">
        <Metric
          label="Weekend prompts"
          value={ratio(current.weekendTurns, summary.totals.turns)}
          hint={`${current.weekendTurns} turns; previous ${ratio(previous.weekendTurns, summary.previous.turns)}`}
        />
        <Metric
          label="Late-night prompts"
          value={ratio(current.lateNightTurns, summary.totals.turns)}
          hint={`22:00-06:00; previous ${ratio(previous.lateNightTurns, summary.previous.turns)}`}
        />
        <Metric
          label="Active-day streak"
          value={`${current.activeStreak} days`}
          hint="Through today or yesterday"
        />
        <Metric
          label="Longest break"
          value={`${current.longestBreak} days`}
          hint={`${current.longestStreak}-day longest active streak`}
        />
      </div>
      <Section
        title="Work hours"
        description={
          peakHour === null
            ? 'No prompt timestamps are available.'
            : `Most prompts were recorded around ${String(peakHour).padStart(2, '0')}:00. Stronger cells mean more activity, not better focus.`
        }
      >
        <div className="overflow-x-auto pb-2">
          <div
            className="grid min-w-[760px] gap-1"
            style={{ gridTemplateColumns: '3rem repeat(24, minmax(1.5rem, 1fr))' }}
          >
            <span />
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="text-center text-[10px] text-muted-foreground">
                {hour}
              </span>
            ))}
            {DAYS.map((day, weekday) => (
              <div key={day} className="contents">
                <span className="self-center text-xs text-muted-foreground">{day}</span>
                {heatmap
                  .filter((cell) => cell.weekday === weekday)
                  .map((cell) => (
                    <IntensityCell
                      key={cell.hour}
                      value={cell.turns}
                      max={max}
                      label={`${day} ${cell.hour}:00: ${cell.turns} user turns`}
                    />
                  ))}
              </div>
            ))}
          </div>
        </div>
        <HeatLegend max={max} />
      </Section>
      <div className="grid gap-4 xl:grid-cols-2">
        <Section
          title="Activity calendar"
          description="Each cell is one local calendar day. Hover or focus a day for its counts."
        >
          <div className="overflow-x-auto pb-2">
            <div
              className="grid w-max grid-flow-col grid-rows-7 gap-1"
              style={{ gridAutoColumns: '2rem' }}
            >
              {DAYS.map((day) => (
                <span key={day} className="self-center text-[10px] text-muted-foreground">
                  {day}
                </span>
              ))}
              {Array.from({ length: firstWeekday }, (_, index) => (
                <span key={`pad-${index}`} />
              ))}
              {summary.daily.map((day) => (
                <IntensityCell
                  key={day.date}
                  value={day.turns}
                  max={maxDaily}
                  label={`${day.date}: ${day.turns} turns, ${day.sessions} sessions`}
                />
              ))}
            </div>
          </div>
          <HeatLegend max={maxDaily} />
        </Section>
        <Section
          title="Prompts by weekday"
          description="Total prompt activity in this window. Weekends use the secondary series colour, not a warning state."
        >
          <div
            className="h-52"
            role="img"
            aria-label="Prompt counts by weekday; exact counts below"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekdays} margin={{ left: -16, right: 12 }}>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="day" tick={chartTick} axisLine={false} tickLine={false} />
                <YAxis tick={chartTick} allowDecimals={false} axisLine={false} tickLine={false} />
                <ChartTooltip contentStyle={chartTooltipStyle} />
                <Bar
                  dataKey="turns"
                  name="User turns"
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                >
                  {weekdays.map((day) => (
                    <Cell key={day.day} fill={CHART_COLORS[day.weekend ? 1 : 0]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <dl className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
            {weekdays.map((day) => (
              <div key={day.day} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full"
                  style={{ background: CHART_COLORS[day.weekend ? 1 : 0] }}
                />
                <dt>{day.day}</dt>
                <dd className="tabular-nums">{day.turns}</dd>
              </div>
            ))}
          </dl>
        </Section>
      </div>
      <Section
        title="Interaction cadence"
        description="Same-session, same-day gaps between user prompts. No response-end timing or concentration score is inferred."
        actions={
          <Explanation text="Continuity is the share of same-session prompt gaps at most 15 minutes. Observed blocks join consecutive prompts across sessions when gaps are at most 15 minutes, without crossing midnight. Parallel intervals are counted only once. These are activity spans, not active work time." />
        }
      >
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Metric
            label="Median prompt gap"
            value={
              current.medianPromptGapMinutes === null
                ? 'Unavailable'
                : `${number(current.medianPromptGapMinutes)} min`
            }
          />
          <Metric
            label="Gaps within 15 minutes"
            value={
              current.continuityPercent === null
                ? 'Unavailable'
                : `${number(current.continuityPercent)}%`
            }
          />
          <Metric
            label="Longest observed block"
            value={`${number(current.longestBlockMinutes)} min`}
          />
          <Metric
            label="Observed block spans"
            value={`${number(current.observedBlockMinutes / 60)} h`}
            hint="Not hours worked"
          />
        </div>
      </Section>
      <Section
        title="Session hygiene"
        description="Counts refer only to observed turns in this window; a resumed session may have earlier history."
      >
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Metric
            label="Sessions with 50+ turns"
            value={number(current.longSessions)}
            hint={`${current.sessionsWithTurns} sessions with prompt activity`}
          />
          <Metric
            label="Single-turn sessions"
            value={number(current.singleTurnSessions)}
            hint="Not assumed abandoned"
          />
          <Metric
            label="Mean turns / prompt session"
            value={
              current.sessionsWithTurns
                ? number(summary.totals.turns / current.sessionsWithTurns)
                : 'Unavailable'
            }
          />
        </div>
      </Section>
      <Section
        title="Schedule observations"
        description="Suggestions appear only with at least 10 recorded turns. They are not a burnout assessment."
      >
        {tips.length ? (
          <ul className="divide-y">
            {tips.map((tip) => (
              <li key={tip} className="max-w-[90ch] py-3 text-sm leading-relaxed">
                {tip}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            {summary.totals.turns < 10
              ? 'Not enough prompt activity for schedule suggestions yet.'
              : 'No schedule or session-length threshold was triggered.'}
          </p>
        )}
      </Section>
    </div>
  )
}
