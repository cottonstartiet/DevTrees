import * as React from 'react'

import type { UnpushedCommitsResult } from '@shared/repo'
import { getUnpushedCommits } from '@/lib/repo'

const POLL_INTERVAL_MS = 60_000

type LoadedUnpushedCommits = Extract<UnpushedCommitsResult, { ok: true }>

export interface UseUnpushedCommitsResult {
  data: LoadedUnpushedCommits | null
  error: string | null
  isLoading: boolean
  refresh: () => Promise<void>
}

export function useUnpushedCommits(
  folderPath: string | null,
  branch: string | null,
  enabled: boolean
): UseUnpushedCommitsResult {
  const key = folderPath && branch ? `${folderPath}::${branch}` : null
  const [snapshot, setSnapshot] = React.useState<{
    key: string | null
    data: LoadedUnpushedCommits | null
    error: string | null
  }>({ key: null, data: null, error: null })
  const [isLoading, setIsLoading] = React.useState(false)
  const activeKeyRef = React.useRef<string | null>(null)
  const requestSeqRef = React.useRef(0)
  const latestAppliedSeqRef = React.useRef(0)

  const isCurrent = snapshot.key === key
  const data = isCurrent ? snapshot.data : null
  const error = isCurrent ? snapshot.error : null

  const runRefresh = React.useCallback(async (): Promise<void> => {
    if (!folderPath || !branch || !key) return
    requestSeqRef.current += 1
    const seq = requestSeqRef.current
    setIsLoading(true)
    try {
      const result = await getUnpushedCommits({ folderPath, branch })
      if (activeKeyRef.current !== key) return
      if (seq < latestAppliedSeqRef.current) return
      latestAppliedSeqRef.current = seq
      if (result.ok) {
        setSnapshot({ key, data: result, error: null })
      } else {
        setSnapshot({ key, data: null, error: result.error })
      }
    } catch (err) {
      if (activeKeyRef.current !== key) return
      if (seq < latestAppliedSeqRef.current) return
      latestAppliedSeqRef.current = seq
      setSnapshot({
        key,
        data: null,
        error: err instanceof Error ? err.message : 'unpushed-commits failed'
      })
    } finally {
      if (seq === requestSeqRef.current) setIsLoading(false)
    }
  }, [folderPath, branch, key])

  React.useEffect(() => {
    activeKeyRef.current = key
    if (!key || !enabled) return
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
  }, [key, enabled, runRefresh])

  return { data, error, isLoading, refresh: runRefresh }
}
