import * as React from 'react'

import type { WorkingCopyStatusResult } from '@shared/repo'
import { getWorkingCopyStatus } from '@/lib/repo'

const POLL_INTERVAL_MS = 30_000

type LoadedStatus = Extract<WorkingCopyStatusResult, { ok: true }>

export interface UseWorkingCopyStatusResult {
  data: LoadedStatus | null
  error: string | null
  isLoading: boolean
  refresh: () => Promise<void>
}

export function useWorkingCopyStatus(
  folderPath: string | null,
  enabled: boolean
): UseWorkingCopyStatusResult {
  const [snapshot, setSnapshot] = React.useState<{
    folderPath: string | null
    data: LoadedStatus | null
    error: string | null
  }>({ folderPath: null, data: null, error: null })
  const [isLoading, setIsLoading] = React.useState(false)
  const activePathRef = React.useRef<string | null>(null)
  const requestSeqRef = React.useRef(0)
  const latestAppliedSeqRef = React.useRef(0)

  const isCurrent = snapshot.folderPath === folderPath
  const data = isCurrent ? snapshot.data : null
  const error = isCurrent ? snapshot.error : null

  const runRefresh = React.useCallback(async (): Promise<void> => {
    if (!folderPath) return
    requestSeqRef.current += 1
    const seq = requestSeqRef.current
    setIsLoading(true)
    try {
      const result = await getWorkingCopyStatus({ folderPath })
      if (activePathRef.current !== folderPath) return
      if (seq < latestAppliedSeqRef.current) return
      latestAppliedSeqRef.current = seq
      if (result.ok) {
        setSnapshot({ folderPath, data: result, error: null })
      } else {
        setSnapshot({ folderPath, data: null, error: result.error })
      }
    } catch (err) {
      if (activePathRef.current !== folderPath) return
      if (seq < latestAppliedSeqRef.current) return
      latestAppliedSeqRef.current = seq
      setSnapshot({
        folderPath,
        data: null,
        error: err instanceof Error ? err.message : 'working-copy-status failed'
      })
    } finally {
      if (seq === requestSeqRef.current) setIsLoading(false)
    }
  }, [folderPath])

  React.useEffect(() => {
    activePathRef.current = folderPath
    if (!folderPath || !enabled) return
    void runRefresh()
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
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [folderPath, enabled, runRefresh])

  return { data, error, isLoading, refresh: runRefresh }
}
