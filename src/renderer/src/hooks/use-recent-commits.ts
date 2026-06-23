import * as React from 'react'

import type { RecentCommitsResult } from '@shared/repo'
import { getRecentCommits } from '@/lib/repo'

const POLL_INTERVAL_MS = 60_000

type LoadedCommits = Extract<RecentCommitsResult, { ok: true }>

export interface UseRecentCommitsResult {
  data: LoadedCommits | null
  error: string | null
  isLoading: boolean
  refresh: () => Promise<void>
}

export function useRecentCommits(
  folderPath: string | null,
  enabled: boolean,
  limit = 10
): UseRecentCommitsResult {
  const [snapshot, setSnapshot] = React.useState<{
    folderPath: string | null
    data: LoadedCommits | null
    error: string | null
  }>({ folderPath: null, data: null, error: null })
  const [isLoading, setIsLoading] = React.useState(false)
  const activePathRef = React.useRef<string | null>(null)

  const isCurrent = snapshot.folderPath === folderPath
  const data = isCurrent ? snapshot.data : null
  const error = isCurrent ? snapshot.error : null

  const runRefresh = React.useCallback(async (): Promise<void> => {
    if (!folderPath) return
    setIsLoading(true)
    try {
      const result = await getRecentCommits({ folderPath, limit })
      if (activePathRef.current !== folderPath) return
      if (result.ok) {
        setSnapshot({ folderPath, data: result, error: null })
      } else {
        setSnapshot({ folderPath, data: null, error: result.error })
      }
    } catch (err) {
      if (activePathRef.current !== folderPath) return
      setSnapshot({
        folderPath,
        data: null,
        error: err instanceof Error ? err.message : 'recent-commits failed'
      })
    } finally {
      setIsLoading(false)
    }
  }, [folderPath, limit])

  React.useEffect(() => {
    activePathRef.current = folderPath
    if (!folderPath || !enabled) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void runRefresh()
    })
    let intervalId: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (intervalId !== null) return
      intervalId = setInterval(() => {
        if (document.visibilityState === 'visible') void runRefresh()
      }, POLL_INTERVAL_MS)
    }
    const stop = (): void => {
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void runRefresh()
        start()
      } else {
        stop()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    if (document.visibilityState === 'visible') start()
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [folderPath, enabled, runRefresh])

  return { data, error, isLoading, refresh: runRefresh }
}
