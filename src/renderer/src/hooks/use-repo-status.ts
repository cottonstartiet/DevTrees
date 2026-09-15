import * as React from 'react'
import { toast } from 'sonner'

import type { RepoStatus } from '@shared/repo'
import { useTasks } from '@/contexts/tasks-context'
import { fetchRepo, getCurrentBranch, getDefaultBranch, getRepoStatus, pullRepo } from '@/lib/repo'

const POLL_INTERVAL_MS = 60_000

export interface UseRepoStatusResult {
  defaultBranch: string | null
  repositoryCurrentBranch: string | null
  status: RepoStatus | null
  isFetching: boolean
  isPulling: boolean
  refresh: () => Promise<void>
  pull: () => Promise<void>
}

export function useRepoStatus(
  repositoryPath: string | null,
  enabled: boolean
): UseRepoStatusResult {
  const [snapshot, setSnapshot] = React.useState<{
    repositoryPath: string | null
    defaultBranch: string | null
    repositoryCurrentBranch: string | null
    status: RepoStatus | null
  }>({
    repositoryPath: null,
    defaultBranch: null,
    repositoryCurrentBranch: null,
    status: null
  })
  const [fetchingPaths, setFetchingPaths] = React.useState<ReadonlySet<string>>(new Set())
  const [pullingPaths, setPullingPaths] = React.useState<ReadonlySet<string>>(new Set())
  const { startTask, succeedTask, failTask } = useTasks()

  const fetchingRef = React.useRef(new Map<string, Promise<void>>())
  const pullingRef = React.useRef(new Set<string>())
  const activePathRef = React.useRef<string | null>(null)

  const isCurrent = snapshot.repositoryPath === repositoryPath
  const defaultBranch = isCurrent ? snapshot.defaultBranch : null
  const repositoryCurrentBranch = isCurrent ? snapshot.repositoryCurrentBranch : null
  const status = isCurrent ? snapshot.status : null

  React.useEffect(() => {
    activePathRef.current = repositoryPath
    if (!repositoryPath || !enabled) return
    let cancelled = false
    void (async (): Promise<void> => {
      const [def, cur] = await Promise.all([
        getDefaultBranch(repositoryPath),
        getCurrentBranch(repositoryPath)
      ])
      if (cancelled || activePathRef.current !== repositoryPath) return
      setSnapshot((prev) => ({
        repositoryPath,
        defaultBranch: def,
        repositoryCurrentBranch: cur,
        status: prev.repositoryPath === repositoryPath ? prev.status : null
      }))
    })().catch((error) => {
      if (!cancelled)
        toast.error(error instanceof Error ? error.message : 'Could not read repository branches.')
    })
    return () => {
      cancelled = true
    }
  }, [repositoryPath, enabled])

  const runRefresh = React.useCallback((): Promise<void> => {
    if (!repositoryPath || !defaultBranch) return Promise.resolve()
    const existing = fetchingRef.current.get(repositoryPath)
    if (existing) return existing
    setFetchingPaths((current) => new Set(current).add(repositoryPath))
    const request = Promise.resolve().then(async () => {
      try {
        const fetchResult = await fetchRepo(repositoryPath, defaultBranch)
        if (!fetchResult.ok) console.warn('[repo] fetch failed:', fetchResult.error)
        const result = await getRepoStatus(repositoryPath, defaultBranch)
        if ('error' in result) {
          console.warn('[repo] status failed:', result.error)
          return
        }
        if (activePathRef.current === repositoryPath) {
          setSnapshot((prev) =>
            prev.repositoryPath === repositoryPath ? { ...prev, status: result } : prev
          )
        }
      } catch (error) {
        console.error('[repo] refresh failed:', error)
        if (activePathRef.current === repositoryPath)
          toast.error(error instanceof Error ? error.message : 'Could not refresh repository.')
      } finally {
        fetchingRef.current.delete(repositoryPath)
        setFetchingPaths((current) => {
          const next = new Set(current)
          next.delete(repositoryPath)
          return next
        })
      }
    })
    fetchingRef.current.set(repositoryPath, request)
    return request
  }, [repositoryPath, defaultBranch])

  React.useEffect(() => {
    if (!repositoryPath || !defaultBranch || !enabled) return
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
  }, [repositoryPath, defaultBranch, enabled, runRefresh])

  const pull = React.useCallback(async (): Promise<void> => {
    if (!repositoryPath || !defaultBranch) {
      toast.error('Default branch is not resolved yet.')
      return
    }
    if (pullingRef.current.has(repositoryPath)) return
    pullingRef.current.add(repositoryPath)
    setPullingPaths((current) => new Set(current).add(repositoryPath))
    const taskId = startTask(`Pulling origin/${defaultBranch}`)
    try {
      const result = await pullRepo(repositoryPath, defaultBranch)
      if (!result.ok) {
        failTask(taskId, result.error)
        toast.error(result.error)
        return
      }
      succeedTask(taskId)
      if (result.alreadyUpToDate) {
        toast.success(`${defaultBranch} is already up to date.`)
      } else {
        toast.success(`Pulled latest into ${defaultBranch}.`)
      }
      const [nextStatus, nextCurrent] = await Promise.all([
        getRepoStatus(repositoryPath, defaultBranch),
        getCurrentBranch(repositoryPath)
      ])
      if (activePathRef.current !== repositoryPath) return
      setSnapshot((prev) => {
        if (prev.repositoryPath !== repositoryPath) return prev
        return {
          ...prev,
          repositoryCurrentBranch: nextCurrent,
          status: 'error' in nextStatus ? prev.status : nextStatus
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pull failed.'
      failTask(taskId, message)
      toast.error(message)
    } finally {
      pullingRef.current.delete(repositoryPath)
      setPullingPaths((current) => {
        const next = new Set(current)
        next.delete(repositoryPath)
        return next
      })
    }
  }, [repositoryPath, defaultBranch, startTask, succeedTask, failTask])

  return {
    defaultBranch,
    repositoryCurrentBranch,
    status,
    isFetching: repositoryPath !== null && fetchingPaths.has(repositoryPath),
    isPulling: repositoryPath !== null && pullingPaths.has(repositoryPath),
    refresh: runRefresh,
    pull
  }
}
