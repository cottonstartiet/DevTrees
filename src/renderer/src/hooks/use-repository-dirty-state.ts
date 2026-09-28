import * as React from 'react'

import type { Repository } from '@shared/repository'
import type { Worktree } from '@shared/worktree'
import { getWorktreeStatus } from '@/lib/worktrees'

const POLL_INTERVAL_MS = 30_000

function pathKey(path: string): string {
  return path.replaceAll('/', '\\').toLowerCase()
}

export function collectRepositoryWorkingTreePaths(
  repositories: Repository[],
  worktreesByRepositoryId: Record<string, Worktree[]>
): string[] {
  const paths = new Map<string, string>()
  for (const repository of repositories) {
    paths.set(pathKey(repository.path), repository.path)
    for (const worktree of worktreesByRepositoryId[repository.id] ?? []) {
      paths.set(pathKey(worktree.path), worktree.path)
    }
  }
  return [...paths.values()]
}

export function useRepositoryDirtyState(
  repositories: Repository[],
  worktreesByRepositoryId: Record<string, Worktree[]>
): number {
  const paths = React.useMemo(
    () => collectRepositoryWorkingTreePaths(repositories, worktreesByRepositoryId),
    [repositories, worktreesByRepositoryId]
  )
  const pathsKey = React.useMemo(() => paths.map(pathKey).sort().join('|'), [paths])
  const pathsRef = React.useRef(paths)
  React.useEffect(() => {
    pathsRef.current = paths
  }, [paths])

  const [dirtyByPath, setDirtyByPath] = React.useState<ReadonlyMap<string, boolean>>(
    () => new Map()
  )
  const mountedRef = React.useRef(true)
  const refreshingRef = React.useRef<Promise<void> | null>(null)
  const refreshQueuedRef = React.useRef(false)

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = React.useCallback((): Promise<void> => {
    if (refreshingRef.current) {
      refreshQueuedRef.current = true
      return refreshingRef.current
    }

    const request = (async (): Promise<void> => {
      do {
        refreshQueuedRef.current = false
        const requestedPaths = pathsRef.current
        const results = await Promise.allSettled(
          requestedPaths.map(async (path) => ({ path, result: await getWorktreeStatus(path) }))
        )
        if (!mountedRef.current) return

        const currentPaths = pathsRef.current
        const currentKeys = new Set(currentPaths.map(pathKey))
        setDirtyByPath((previous) => {
          const next = new Map<string, boolean>()
          for (const [key, dirty] of previous) {
            if (currentKeys.has(key)) next.set(key, dirty)
          }
          for (const settled of results) {
            if (settled.status !== 'fulfilled' || !settled.value.result.ok) continue
            const key = pathKey(settled.value.path)
            if (currentKeys.has(key)) next.set(key, settled.value.result.hasChanges)
          }
          return next
        })
      } while (refreshQueuedRef.current && mountedRef.current)
    })().finally(() => {
      refreshingRef.current = null
    })

    refreshingRef.current = request
    return request
  }, [])

  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })

    let intervalId: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (intervalId !== null) return
      intervalId = setInterval(() => {
        if (document.visibilityState === 'visible') void refresh()
      }, POLL_INTERVAL_MS)
    }
    const stop = (): void => {
      if (intervalId === null) return
      clearInterval(intervalId)
      intervalId = null
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh()
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
  }, [pathsKey, refresh])

  return React.useMemo(() => [...dirtyByPath.values()].filter(Boolean).length, [dirtyByPath])
}
