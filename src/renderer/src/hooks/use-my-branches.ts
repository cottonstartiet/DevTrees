import * as React from 'react'

import type { MyBranchesResult } from '@shared/repo'
import { getMyBranches } from '@/lib/repo'

const POLL_INTERVAL_MS = 60_000

type LoadedMyBranches = Extract<MyBranchesResult, { ok: true }>

export interface UseMyBranchesResult {
  data: LoadedMyBranches | null
  error: string | null
  isLoading: boolean
  refresh: () => Promise<void>
}

export function useMyBranches(
  repositoryPath: string | null,
  enabled: boolean
): UseMyBranchesResult {
  const [snapshot, setSnapshot] = React.useState<{
    repositoryPath: string | null
    data: LoadedMyBranches | null
    error: string | null
  }>({ repositoryPath: null, data: null, error: null })
  const [isLoading, setIsLoading] = React.useState(false)
  const activePathRef = React.useRef<string | null>(null)

  const isCurrent = snapshot.repositoryPath === repositoryPath
  const data = isCurrent ? snapshot.data : null
  const error = isCurrent ? snapshot.error : null

  const runRefresh = React.useCallback(async (): Promise<void> => {
    if (!repositoryPath) return
    setIsLoading(true)
    try {
      const result = await getMyBranches({ repositoryPath })
      if (activePathRef.current !== repositoryPath) return
      if (result.ok) {
        setSnapshot({ repositoryPath, data: result, error: null })
      } else {
        setSnapshot({ repositoryPath, data: null, error: result.error })
      }
    } catch (err) {
      if (activePathRef.current !== repositoryPath) return
      setSnapshot({
        repositoryPath,
        data: null,
        error: err instanceof Error ? err.message : 'list-my-branches failed'
      })
    } finally {
      setIsLoading(false)
    }
  }, [repositoryPath])

  React.useEffect(() => {
    activePathRef.current = repositoryPath
    if (!repositoryPath || !enabled) return
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
  }, [repositoryPath, enabled, runRefresh])

  return { data, error, isLoading, refresh: runRefresh }
}
