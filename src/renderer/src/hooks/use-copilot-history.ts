import * as React from 'react'

import type { CopilotHistorySession } from '@shared/copilot-history'

type HistoryState = {
  sessions: CopilotHistorySession[]
  /** Null while healthy; a message when the store exists but could not be read. */
  error: string | null
}

export interface UseCopilotHistoryResult {
  sessions: CopilotHistorySession[]
  error: string | null
  isLoading: boolean
  refresh: () => Promise<void>
}

/**
 * Load the complete cross-source list of recorded Copilot sessions from the CLI's own store. The
 * list is read fresh on mount and whenever `refresh()` is called (e.g. each time the History view is
 * opened). A "store missing" result is treated as simply empty; only a genuine read failure sets
 * `error`.
 */
export function useCopilotHistory(): UseCopilotHistoryResult {
  const [state, setState] = React.useState<HistoryState>({ sessions: [], error: null })
  const [isLoading, setIsLoading] = React.useState(true)

  const refresh = React.useCallback(async (): Promise<void> => {
    setIsLoading(true)
    try {
      const result = await window.api.copilotHistory.list()
      if (result.ok) {
        setState({ sessions: result.sessions, error: null })
      } else if (result.reason === 'missing') {
        setState({ sessions: [], error: null })
      } else {
        setState({ sessions: [], error: result.message })
      }
    } catch (err) {
      setState({
        sessions: [],
        error: err instanceof Error ? err.message : 'Failed to load Copilot session history.'
      })
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })
    return () => {
      cancelled = true
    }
  }, [refresh])

  return { sessions: state.sessions, error: state.error, isLoading, refresh }
}
