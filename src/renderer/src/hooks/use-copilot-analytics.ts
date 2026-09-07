import * as React from 'react'

import type { CopilotAnalyticsSummary } from '@shared/copilot-analytics'

export type UseCopilotAnalyticsResult = {
  summary: CopilotAnalyticsSummary | null
  error: string | null
  isLoading: boolean
  windowDays: number
  setWindowDays: (days: number) => void
  refresh: () => Promise<void>
}

/**
 * Loads the aggregated Copilot usage summary for the selected window, re-fetching whenever the
 * window changes or `refresh()` is called. A "store missing" result reads as an empty summary
 * (no sessions recorded yet); only a genuine read failure sets `error`.
 */
export function useCopilotAnalytics(initialWindowDays = 30): UseCopilotAnalyticsResult {
  const [windowDays, setWindowDays] = React.useState(initialWindowDays)
  const [summary, setSummary] = React.useState<CopilotAnalyticsSummary | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)

  const refresh = React.useCallback(async (): Promise<void> => {
    setIsLoading(true)
    try {
      const result = await window.api.copilotAnalytics.summary(windowDays)
      if (result.ok) {
        setSummary(result.summary)
        setError(null)
      } else if (result.reason === 'missing') {
        setSummary(null)
        setError(null)
      } else {
        setError(result.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Copilot analytics.')
    } finally {
      setIsLoading(false)
    }
  }, [windowDays])

  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })
    return () => {
      cancelled = true
    }
  }, [refresh])

  return { summary, error, isLoading, windowDays, setWindowDays, refresh }
}
