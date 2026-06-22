import * as React from 'react'

import type { AdoPrThreadsResult } from '@shared/ado'
import { getAdoPrThreads } from '@/lib/ado'

type LoadedPrThreads = Extract<AdoPrThreadsResult, { ok: true }>

export interface UsePrThreadsResult {
  data: LoadedPrThreads | null
  error: string | null
  isLoading: boolean
  refresh: () => Promise<void>
}

export function usePrThreads(
  folderPath: string | null,
  pullRequestId: number | null,
  enabled: boolean
): UsePrThreadsResult {
  const key = folderPath && pullRequestId ? `${folderPath}::${pullRequestId}` : null
  const [snapshot, setSnapshot] = React.useState<{
    key: string | null
    data: LoadedPrThreads | null
    error: string | null
  }>({ key: null, data: null, error: null })
  const [isLoading, setIsLoading] = React.useState(false)
  const activeKeyRef = React.useRef<string | null>(null)

  const isCurrent = snapshot.key === key
  const data = isCurrent ? snapshot.data : null
  const error = isCurrent ? snapshot.error : null

  const runRefresh = React.useCallback(async (): Promise<void> => {
    if (!folderPath || !pullRequestId || !key) return
    setIsLoading(true)
    try {
      const result = await getAdoPrThreads({ folderPath, pullRequestId })
      if (activeKeyRef.current !== key) return
      if (result.ok) {
        setSnapshot({ key, data: result, error: null })
      } else {
        setSnapshot({ key, data: null, error: result.message ?? result.code })
      }
    } catch (err) {
      if (activeKeyRef.current !== key) return
      setSnapshot({
        key,
        data: null,
        error: err instanceof Error ? err.message : 'pr-threads failed'
      })
    } finally {
      setIsLoading(false)
    }
  }, [folderPath, pullRequestId, key])

  React.useEffect(() => {
    activeKeyRef.current = key
    if (!key || !enabled) return
    void runRefresh()
  }, [key, enabled, runRefresh])

  return { data, error, isLoading, refresh: runRefresh }
}
