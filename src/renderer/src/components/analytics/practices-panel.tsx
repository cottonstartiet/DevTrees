import { useId, useState } from 'react'
import {
  CartesianGrid,
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import type {
  AnalyticsExample,
  AnalyticsFinding,
  AnalyticsPractices,
  AnalyticsWorkflow
} from '@shared/copilot-analytics'
import { CHART_COLORS, chartTick, chartTooltipStyle, number, ratio, SOURCE_LABELS } from './format'
import { Explanation, Metric, Section } from './shared'

export function Findings({ findings }: { findings: AnalyticsFinding[] }): React.JSX.Element {
  return (
    <ul className="divide-y">
      {findings.map((finding) => (
        <li key={finding.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{finding.title}</h3>
            <span className="inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10px]">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full"
                style={{ background: CHART_COLORS[finding.severity === 'opportunity' ? 1 : 0] }}
              />
              {finding.severity}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {finding.evidenceCount} observations / {finding.sampleSize} analyzed
            </span>
          </div>
          <p className="max-w-[90ch] text-xs leading-relaxed">{finding.observation}</p>
          <p className="max-w-[90ch] text-xs leading-relaxed text-muted-foreground">
            {finding.recommendation}
          </p>
        </li>
      ))}
    </ul>
  )
}

function ExampleRows({ examples }: { examples: AnalyticsExample[] }): React.JSX.Element {
  return (
    <ul className="divide-y">
      {examples.map((example) => (
        <li key={`${example.sessionId}:${example.turnIndex}`} className="space-y-2 py-3">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{example.date}</span>
            <span>{SOURCE_LABELS[example.source]}</span>
            <span className="break-all">{example.repository}</span>
          </div>
          <p className="max-w-[90ch] whitespace-pre-wrap break-words text-sm">{example.text}</p>
          {example.issues.length ? (
            <p className="text-xs text-muted-foreground">{example.issues.join(' / ')}</p>
          ) : null}
          <div className="break-all font-mono text-[10px] text-muted-foreground">
            Session {example.sessionId}, turn {example.turnIndex}
          </div>
        </li>
      ))}
    </ul>
  )
}

function Examples({
  examples,
  label
}: {
  examples: AnalyticsExample[]
  label: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="border-t pt-2">
      <summary className="cursor-pointer rounded py-1 text-xs text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring">
        {label} (prompt excerpts)
      </summary>
      {open ? <ExampleRows examples={examples} /> : null}
    </details>
  )
}

function WorkflowRow({
  workflow,
  index
}: {
  workflow: AnalyticsWorkflow
  index: number
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const copyDraft = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(workflow.draft)
      toast.success('Workflow draft copied. Review it before saving as a prompt or skill.')
    } catch {
      toast.error('Could not copy the draft. Select and copy the text below instead.')
    }
  }
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="border-b py-3 last:border-0"
    >
      <summary className="cursor-pointer rounded text-sm focus-visible:ring-3 focus-visible:ring-ring">
        Recurring pattern {index + 1}
        <span className="ml-3 text-xs text-muted-foreground">
          {workflow.occurrences} occurrences / {workflow.sessions} sessions /{' '}
          {workflow.sources.map((source) => SOURCE_LABELS[source]).join(', ')}
        </span>
      </summary>
      {open ? (
        <div className="space-y-3 pt-3">
          <ExampleRows examples={workflow.examples} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-medium">Editable starting point, not an installed skill</h3>
            <Button size="sm" variant="outline" onClick={() => void copyDraft()}>
              Copy draft
            </Button>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
            {workflow.draft}
          </pre>
        </div>
      ) : null}
    </details>
  )
}

export function PracticesPanel({
  practices
}: {
  practices: AnalyticsPractices
}): React.JSX.Element {
  const trendFillId = useId()
  const intentColors: Record<string, string> = {
    Planning: CHART_COLORS[0],
    Implementation: CHART_COLORS[1],
    Debugging: CHART_COLORS[2],
    Review: CHART_COLORS[3],
    Exploration: CHART_COLORS[4]
  }
  const intentData = practices.intents.map((intent) => ({
    ...intent,
    color: intentColors[intent.name] ?? 'var(--color-muted-foreground)'
  }))
  return (
    <div className="space-y-4">
      <p className="max-w-[90ch] text-xs leading-relaxed text-muted-foreground">
        Local, English-keyword heuristics over saved user prompts. These measure visible prompt
        structure, not engineering skill or task success. Short confirmations and recognized system
        messages are excluded. Inline context checks cannot see context supplied automatically by
        the IDE. Prompt excerpts stay hidden until expanded.
      </p>
      <div className="grid grid-cols-2 gap-4 border-y py-2 lg:grid-cols-4">
        <Metric
          label="Prompt structure"
          value={
            practices.score === null
              ? 'Unavailable'
              : `${number(practices.score)} / 100 (${practices.grade})`
          }
          hint={
            practices.analyzedPrompts < 20
              ? 'Limited sample: fewer than 20 prompts'
              : 'Heuristic, not a quality verdict'
          }
        />
        <Metric
          label="Prompts analyzed"
          value={number(practices.analyzedPrompts)}
          hint={`${number(practices.excludedPrompts)} confirmations/system/short follow-ups excluded`}
        />
        <Metric
          label="Spec-like starts"
          value={ratio(practices.specDrivenSessions, practices.specEligibleSessions)}
          hint={`${practices.specDrivenSessions} / ${practices.specEligibleSessions} eligible sessions`}
        />
        <Metric
          label="Repeated workflows"
          value={number(practices.workflows.length)}
          hint="3+ repetitions across 2+ sessions"
        />
      </div>
      {practices.sampled || practices.truncatedPrompts ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-xs">
          Prompt analysis uses up to the latest 5,000 turns in this selection; activity totals still
          cover the full period.
          {practices.truncatedPrompts > 0
            ? ` ${practices.truncatedPrompts} long prompts were limited to 8,000 characters.`
            : ''}
        </p>
      ) : null}
      <Section
        title="Recommended practices"
        description="Thresholds require evidence. A lack of findings does not prove all practices are healthy."
      >
        {practices.findings.length ? (
          <Findings findings={practices.findings} />
        ) : (
          <p className="text-xs text-muted-foreground">
            {practices.analyzedPrompts < 10
              ? 'Not enough substantive prompts for aggregate coaching yet.'
              : 'No supported prompt-coaching threshold was triggered.'}
          </p>
        )}
      </Section>
      <Section
        title="Prompt structure dimensions"
        actions={
          <Explanation text="Five equally weighted dimensions. Keyword presence determines constraints, success criteria and verification. Inline file/code references determine visible context. Length, lists and multiline structure determine specificity. Grades: A >=80, B >=60, C >=40, D >=20, F <20. A low score may be entirely appropriate for a conversational follow-up." />
        }
      >
        {practices.dimensions.length ? (
          <div className="space-y-3">
            {practices.dimensions.map((dimension, index) => (
              <div key={dimension.name} className="grid gap-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span>{dimension.name}</span>
                  <span className="tabular-nums">{number(dimension.score)} / 100</span>
                </div>
                <div
                  className="h-2.5 overflow-hidden rounded-full bg-muted"
                  role="meter"
                  aria-label={dimension.name}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={dimension.score}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${dimension.score}%`,
                      background: CHART_COLORS[index % CHART_COLORS.length]
                    }}
                  />
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {dimension.explanation}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No eligible prompt text is available.</p>
        )}
        {practices.examples.length ? (
          <Examples examples={practices.examples} label="Show lower-scoring examples" />
        ) : null}
      </Section>
      {practices.trend.length > 1 ? (
        <Section
          title="Prompt structure over time"
          description="Average daily score for analyzed prompts; days without eligible prompts are not scored."
        >
          <div className="h-52" role="img" aria-label="Daily prompt-structure trend">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={practices.trend} margin={{ left: -16, right: 12 }}>
                <defs>
                  <linearGradient id={trendFillId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS[1]} stopOpacity={0.35} />
                    <stop offset="95%" stopColor={CHART_COLORS[1]} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis
                  dataKey="date"
                  tick={chartTick}
                  tickFormatter={(value: string) => value.slice(5)}
                  minTickGap={30}
                />
                <YAxis domain={[0, 100]} tick={chartTick} />
                <Tooltip
                  contentStyle={chartTooltipStyle}
                  formatter={(value) => number(Number(value))}
                />
                <Area
                  type="monotone"
                  dataKey="score"
                  name="Structure score"
                  stroke={CHART_COLORS[1]}
                  strokeWidth={2}
                  fill={`url(#${trendFillId})`}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer rounded py-1 text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring">
              View trend data
            </summary>
            <ul className="max-h-48 divide-y overflow-auto">
              {practices.trend.map((day) => (
                <li key={day.date} className="flex gap-4 py-2">
                  <span>{day.date}</span>
                  <span>{number(day.score)} / 100</span>
                  <span>{day.prompts} prompts</span>
                </li>
              ))}
            </ul>
          </details>
        </Section>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        <Section
          title="Session intent"
          description={`Keyword votes across analyzed prompts in ${practices.classifiedSessions} sessions. Ambiguous sessions stay unclassified; tied votes use debugging, review, planning, exploration, then implementation.`}
        >
          {practices.classifiedSessions > 0 ? (
            <div
              className="h-52"
              role="img"
              aria-label="Session intent distribution; exact counts below"
            >
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={intentData.filter((intent) => intent.sessions > 0)}
                    dataKey="sessions"
                    nameKey="name"
                    innerRadius={45}
                    outerRadius={72}
                    paddingAngle={2}
                    isAnimationActive={false}
                  >
                    {intentData
                      .filter((intent) => intent.sessions > 0)
                      .map((intent) => (
                        <Cell key={intent.name} fill={intent.color} />
                      ))}
                  </Pie>
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    formatter={(value) => `${value} sessions`}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : null}
          <ul className="divide-y">
            {intentData.map((intent) => (
              <li key={intent.name} className="flex justify-between gap-3 py-2 text-xs">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full"
                    style={{ background: intent.color }}
                  />
                  {intent.name}
                </span>
                <span className="tabular-nums">
                  {intent.sessions} / {ratio(intent.sessions, practices.classifiedSessions)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
        <Section
          title="Spec-driven starts"
          description="Only sessions whose original first turn is available in this window and that have at least three observed turns are eligible."
        >
          {practices.specEligibleSessions > 0 ? (
            <div className="space-y-2">
              <div
                className="flex h-3 overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label="Spec-like session starts"
                aria-valuemin={0}
                aria-valuemax={practices.specEligibleSessions}
                aria-valuenow={practices.specDrivenSessions}
              >
                <div
                  style={{
                    width: `${(practices.specDrivenSessions / practices.specEligibleSessions) * 100}%`,
                    background: CHART_COLORS[1]
                  }}
                />
                <div
                  className="flex-1"
                  style={{
                    background: `color-mix(in oklch, ${CHART_COLORS[0]} 25%, var(--color-card))`
                  }}
                />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full"
                    style={{ background: CHART_COLORS[1] }}
                  />
                  Spec-like: {practices.specDrivenSessions}
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full"
                    style={{ background: CHART_COLORS[0] }}
                  />
                  No detected structure:{' '}
                  {practices.specEligibleSessions - practices.specDrivenSessions}
                </span>
              </div>
            </div>
          ) : null}
          <p className="text-sm">
            {practices.specDrivenSessions} of {practices.specEligibleSessions} eligible sessions
            begin with spec keywords, a plan or structured list.
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            This is a spec-like prompt signal, not proof that a specification was followed. Resumed
            conversations are not treated as new tasks.
          </p>
          {practices.unstructuredExamples.length ? (
            <Examples examples={practices.unstructuredExamples} label="Show unstructured starts" />
          ) : null}
        </Section>
      </div>
      <Section
        title="Recurring workflows"
        description="Conservative matching after normalizing case, paths, numbers and quoted variables. Expand a pattern to see private excerpts and a reusable draft. No time savings are claimed."
      >
        {practices.workflows.length ? (
          practices.workflows.map((workflow, index) => (
            <WorkflowRow key={workflow.id} workflow={workflow} index={index} />
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            No prompt pattern recurred three times across at least two sessions in this selection.
          </p>
        )}
      </Section>
    </div>
  )
}
