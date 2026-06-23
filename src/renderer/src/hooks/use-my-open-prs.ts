import * as React from 'react'

import type { AdoMyOpenPrsResult } from '@shared/ado'
import { getAdoMyOpenPrs } from '@/lib/ado'

type LoadedMyOpenPrs = Extract<AdoMyOpenPrsResult, { ok: true }>

export interface UseMyOpenPrsResult {
  data: LoadedMyOpenPrs | null
  error: string | null
  isLoading: boolean
  refresh: () => Promise<void>
}

export function useMyOpenPrs(folderPath: string | null, enabled: boolean): UseMyOpenPrsResult {
  const [snapshot, setSnapshot] = React.useState<{
    folderPath: string | null
    data: LoadedMyOpenPrs | null
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
      const result = await getAdoMyOpenPrs({ folderPath })
      if (activePathRef.current !== folderPath) return
      if (result.ok) {
        setSnapshot({ folderPath, data: result, error: null })
      } else {
        setSnapshot({ folderPath, data: null, error: result.message ?? result.code })
      }
    } catch (err) {
      if (activePathRef.current !== folderPath) return
      setSnapshot({
        folderPath,
        data: null,
        error: err instanceof Error ? err.message : 'my-open-prs failed'
      })
    } finally {
      setIsLoading(false)
    }
  }, [folderPath])

  React.useEffect(() => {
    activePathRef.current = folderPath
    if (!folderPath || !enabled) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void runRefresh()
    })
    return () => {
      cancelled = true
    }
  }, [folderPath, enabled, runRefresh])

  return { data, error, isLoading, refresh: runRefresh }
}
