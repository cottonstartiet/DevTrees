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

export function useRepoStatus(repositoryPath: string | null, enabled: boolean): UseRepoStatusResult {
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
  const [isFetching, setIsFetching] = React.useState(false)
  const [isPulling, setIsPulling] = React.useState(false)
  const { startTask, succeedTask, failTask } = useTasks()

  const fetchingRef = React.useRef(false)
  const pullingRef = React.useRef(false)
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
    })()
    return () => {
      cancelled = true
    }
  }, [repositoryPath, enabled])

  const runRefresh = React.useCallback(async (): Promise<void> => {
    if (!repositoryPath || !defaultBranch) return
    if (fetchingRef.current) return
    fetchingRef.current = true
    setIsFetching(true)
    try {
      const fetchResult = await fetchRepo(repositoryPath, defaultBranch)
      if (!fetchResult.ok) {
        console.warn('[repo] fetch failed:', fetchResult.error)
      }
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
    } finally {
      fetchingRef.current = false
      setIsFetching(false)
    }
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
    if (pullingRef.current) return
    pullingRef.current = true
    setIsPulling(true)
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
    } finally {
      pullingRef.current = false
      setIsPulling(false)
    }
  }, [repositoryPath, defaultBranch, startTask, succeedTask, failTask])

  return {
    defaultBranch,
    repositoryCurrentBranch,
    status,
    isFetching,
    isPulling,
    refresh: runRefresh,
    pull
  }
}
