/**
 * Read-only local analytics over Copilot CLI's session-store.db.
 * Prompt coaching is deterministic; no model calls or external uploads are involved.
 */

/** Per-model token/cost roll-up within the selected window. */
export type CopilotModelUsage = {
  model: string
  source: AnalyticsSource
  /** Model calls, not user turns. */
  events: number
  creditRecords: number
  inputRecords: number
  outputRecords: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Raw cost unit the CLI bills in: 1e11 nano-AIU == 1 AI credit == $0.01 (published rate). */
  costNanoAiu: number
}

/** One day's activity, used to draw the usage-over-time chart. Always present for every day in
 *  the window, even if zero, so the chart has no gaps. */
export type CopilotDailyUsage = {
  /** `YYYY-MM-DD`, in the desktop machine's local timezone. */
  date: string
  sessions: number
  turns: number
  events: number
  inputTokens: number
  outputTokens: number
  costNanoAiu: number
}

/** Per-repository roll-up within the selected window. */
export type CopilotRepositoryUsage = {
  repository: string
  sessions: number
  turns: number
  events: number
  costNanoAiu: number
}

/** A file Copilot touched within the selected window. */
export type CopilotFileActivity = {
  path: string
  repository: string
  creates: number
  edits: number
  touches: number
}

export type CopilotAnalyticsTotals = {
  /** Sessions with any recorded activity (turns or model usage) in the window. */
  sessions: number
  turns: number
  /** Distinct local calendar days with a turn or usage record. */
  activeDays: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costNanoAiu: number
  /** Average model-call latency; null when timings are missing. */
  avgResponseMs: number | null
  /** Average time to first streamed token in ms; null when there's no usage data. */
  avgTimeToFirstTokenMs: number | null
  filesCreated: number
  filesEdited: number
  uniqueFiles: number
  usageRecords: number
  creditRecords: number
  p50ResponseMs: number | null
  p95ResponseMs: number | null
}

export type AnalyticsSource = 'cli'

export type AnalyticsCoverageSource = {
  source: AnalyticsSource
  sessions: number
  turns: number
  sessionsWithUsage: number
  usageRecords: number
  tokenRecords: number
  creditRecords: number
  timedRecords: number
  avgResponseMs: number | null
}

export type AnalyticsCadence = {
  weekendTurns: number
  lateNightTurns: number
  activeStreak: number
  longestStreak: number
  longestBreak: number
  medianPromptGapMinutes: number | null
  continuityPercent: number | null
  observedBlockMinutes: number
  longestBlockMinutes: number
  longSessions: number
  singleTurnSessions: number
  sessionsWithTurns: number
}

export type AnalyticsExample = {
  sessionId: string
  turnIndex: number
  source: AnalyticsSource
  repository: string
  date: string
  text: string
  issues: string[]
}

export type AnalyticsFinding = {
  id: string
  title: string
  severity: 'suggestion' | 'opportunity'
  observation: string
  recommendation: string
  evidenceCount: number
  sampleSize: number
}

export type AnalyticsWorkflow = {
  id: string
  occurrences: number
  sessions: number
  repositories: string[]
  sources: AnalyticsSource[]
  examples: AnalyticsExample[]
  draft: string
}

export type AnalyticsPractices = {
  analyzedPrompts: number
  availablePrompts: number
  excludedPrompts: number
  sampled: boolean
  truncatedPrompts: number
  score: number | null
  grade: string | null
  dimensions: { name: string; score: number; explanation: string }[]
  trend: { date: string; score: number; prompts: number }[]
  intents: { name: string; sessions: number }[]
  classifiedSessions: number
  specEligibleSessions: number
  specDrivenSessions: number
  findings: AnalyticsFinding[]
  examples: AnalyticsExample[]
  unstructuredExamples: AnalyticsExample[]
  workflows: AnalyticsWorkflow[]
}

export type CopilotAnalyticsSummary = {
  windowDays: number
  source: AnalyticsSource
  repository: string | null
  repositories: string[]
  calculatedAt: string
  fromDate: string
  toDate: string
  totals: CopilotAnalyticsTotals
  previous: CopilotAnalyticsTotals
  daily: CopilotDailyUsage[]
  models: CopilotModelUsage[]
  topRepositories: CopilotRepositoryUsage[]
  topFiles: CopilotFileActivity[]
  coverage: {
    usageAvailable: boolean
    filesAvailable: boolean
    promptsAvailable: boolean
    sources: AnalyticsCoverageSource[]
    warnings: string[]
  }
  flow: {
    current: AnalyticsCadence
    previous: AnalyticsCadence
    heatmap: { weekday: number; hour: number; turns: number }[]
    peakHour: number | null
    tips: string[]
  }
  practices: AnalyticsPractices
}

/**
 * A missing source produces a successful report with availability warnings. The legacy missing
 * variant remains accepted by the bridge; unreadable indicates a failed selected-source report.
 */
export type CopilotAnalyticsResult =
  | { ok: true; summary: CopilotAnalyticsSummary }
  | { ok: false; reason: 'missing' | 'unreadable'; message: string }

/** Nano-AIU units per AI credit; 1 AI credit is published at $0.01. */
export const NANO_AIU_PER_CREDIT = 1e11

export function nanoAiuToCredits(nanoAiu: number): number {
  return nanoAiu / NANO_AIU_PER_CREDIT
}
