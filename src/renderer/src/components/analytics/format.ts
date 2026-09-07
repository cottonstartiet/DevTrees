import { nanoAiuToCredits } from '@shared/copilot-analytics'

export const SOURCE_LABELS = { cli: 'Copilot CLI' }

export const CHART_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)'
]

export function number(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

export function credits(nano: number): string {
  const value = nanoAiuToCredits(nano)
  return value > 0 && value < 0.01
    ? '<0.01'
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function duration(ms: number | null): string {
  if (ms === null) return 'Unavailable'
  return ms >= 1000 ? `${number(ms / 1000)}s` : `${number(ms)}ms`
}

export function ratio(count: number, total: number): string {
  return total > 0 ? `${number((count / total) * 100)}%` : 'Unavailable'
}

export function change(current: number, previous: number): string {
  if (previous === 0)
    return current === 0 ? 'No activity in either period' : 'No previous-period baseline'
  const delta = ((current - previous) / previous) * 100
  return `${delta > 0 ? '+' : ''}${number(delta)}% vs previous period`
}

export const chartTooltipStyle = {
  background: 'var(--color-popover)',
  color: 'var(--color-popover-foreground)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  fontSize: 12
}

export const chartTick = { fontSize: 11, fill: 'var(--color-muted-foreground)' }
