/**
 * Aggregated analytics computed from the Copilot CLI's own store at
 * `~/.copilot/session-store.db`. Read-only, same source as `copilot-history.ts`, but rolled up
 * across sessions/turns/model-usage-events/touched-files instead of listed per session.
 */

/** Per-model token/cost roll-up within the selected window. */
export type CopilotModelUsage = {
  model: string
  /** Number of assistant turns/requests billed to this model. */
  events: number
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
  /** `YYYY-MM-DD`, UTC. */
  date: string
  sessions: number
  events: number
  inputTokens: number
  outputTokens: number
  costNanoAiu: number
}

/** Per-repository roll-up within the selected window. */
export type CopilotRepositoryUsage = {
  repository: string
  sessions: number
  events: number
  costNanoAiu: number
}

/** A file Copilot touched within the selected window. */
export type CopilotFileActivity = {
  path: string
  creates: number
  edits: number
  touches: number
}

export type CopilotAnalyticsTotals = {
  /** Sessions with any recorded activity (turns or model usage) in the window. */
  sessions: number
  turns: number
  /** Distinct calendar days (UTC) with at least one recorded turn. */
  activeDays: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costNanoAiu: number
  /** Average per-request latency in ms, across all model calls; null when there's no usage data. */
  avgResponseMs: number | null
  /** Average time to first streamed token in ms; null when there's no usage data. */
  avgTimeToFirstTokenMs: number | null
  filesCreated: number
  filesEdited: number
}

export type CopilotAnalyticsSummary = {
  windowDays: number
  totals: CopilotAnalyticsTotals
  daily: CopilotDailyUsage[]
  models: CopilotModelUsage[]
  topRepositories: CopilotRepositoryUsage[]
  topFiles: CopilotFileActivity[]
}

/**
 * Mirrors `CopilotHistoryListResult`: distinguishes an empty-but-healthy store (`missing`) from
 * one that couldn't be read (`unreadable`), so the UI can show an actionable error.
 */
export type CopilotAnalyticsResult =
  | { ok: true; summary: CopilotAnalyticsSummary }
  | { ok: false; reason: 'missing' | 'unreadable'; message: string }

/** Nano-AIU units per AI credit; 1 AI credit is published at $0.01. */
export const NANO_AIU_PER_CREDIT = 1e11

export function nanoAiuToCredits(nanoAiu: number): number {
  return nanoAiu / NANO_AIU_PER_CREDIT
}
