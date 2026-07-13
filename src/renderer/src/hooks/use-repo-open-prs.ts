import * as React from 'react'

import type { RepoPr } from '@shared/reviews'
import type { WorkspaceRemoteKind } from '@shared/workspace'
import { getRepoOpenPrs } from '@/lib/reviews'

export interface UseRepoOpenPrsResult {
  prs: RepoPr[] | null
  error: string | null
  isLoading: boolean
  /** True when the selected workspace's remote is neither GitHub nor Azure DevOps. */
  isUnsupported: boolean
  refresh: () => Promise<void>
}

/**
 * Fetches all open PRs for a workspace, dispatching to the ADO or GitHub backend by `remoteKind`.
 * Snapshots are keyed by `folderPath` so a slow response for a no-longer-selected repo is discarded
 * (avoids workspace-switch races). Mirrors `use-my-open-prs`.
 */
export function useRepoOpenPrs(
  folderPath: string | null,
  remoteKind: WorkspaceRemoteKind | null,
  enabled: boolean
): UseRepoOpenPrsResult {
  const [snapshot, setSnapshot] = React.useState<{
    folderPath: string | null
    prs: RepoPr[] | null
    error: string | null
  }>({ folderPath: null, prs: null, error: null })
  const [isLoading, setIsLoading] = React.useState(false)
  const activePathRef = React.useRef<string | null>(null)

  const isUnsupported = remoteKind !== null && remoteKind !== 'ado' && remoteKind !== 'github'
  const isCurrent = snapshot.folderPath === folderPath
  const prs = isCurrent ? snapshot.prs : null
  const error = isCurrent ? snapshot.error : null

  const runRefresh = React.useCallback(async (): Promise<void> => {
    if (!folderPath || !remoteKind) return
    const request = getRepoOpenPrs(remoteKind, { folderPath })
    if (!request) {
      setSnapshot({ folderPath, prs: null, error: null })
      return
    }
    setIsLoading(true)
    try {
      const result = await request
      if (activePathRef.current !== folderPath) return
      if (result.ok) {
        setSnapshot({ folderPath, prs: result.prs, error: null })
      } else {
        setSnapshot({ folderPath, prs: null, error: result.message ?? result.code })
      }
    } catch (err) {
      if (activePathRef.current !== folderPath) return
      setSnapshot({
        folderPath,
        prs: null,
        error: err instanceof Error ? err.message : 'Failed to load pull requests'
      })
    } finally {
      if (activePathRef.current === folderPath) setIsLoading(false)
    }
  }, [folderPath, remoteKind])

  React.useEffect(() => {
    activePathRef.current = folderPath
    if (!folderPath || !enabled || isUnsupported) {
      // No fetch will run for this selection, so clear any spinner left by an in-flight request
      // for a previously-selected (now abandoned) repo.
      setIsLoading(false)
      return
    }
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void runRefresh()
    })
    return () => {
      cancelled = true
    }
  }, [folderPath, enabled, isUnsupported, runRefresh])

  return { prs, error, isLoading, isUnsupported, refresh: runRefresh }
}
