import * as React from 'react'

import { getRepoOpenPrs } from '@/lib/reviews'
import type { RepoPr } from '@shared/reviews'
import type { Repository } from '@shared/repository'

const REFRESH_INTERVAL_MS = 5 * 60 * 1000

export type DashboardAssignedPr = {
  key: string
  repository: Repository
  pr: RepoPr
}

export type DashboardPrReviews = {
  items: DashboardAssignedPr[]
  errors: string[]
  isLoading: boolean
  refresh: () => Promise<void>
}

function reviewKey(repository: Repository, pr: RepoPr): string {
  return `${repository.path.toLowerCase()}::${pr.provider}::${pr.id}`
}

export function useDashboardPrReviews(repositories: Repository[]): DashboardPrReviews {
  const [items, setItems] = React.useState<DashboardAssignedPr[]>([])
  const [errors, setErrors] = React.useState<string[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const refreshSequenceRef = React.useRef(0)

  const supportedRepositories = React.useMemo(
    () => repositories.filter((repository) => repository.remoteKind !== 'other'),
    [repositories]
  )
  const repositoryKey = React.useMemo(
    () =>
      supportedRepositories
        .map((repository) => `${repository.id}:${repository.path}:${repository.remoteKind}`)
        .sort()
        .join('|'),
    [supportedRepositories]
  )

  const refresh = React.useCallback(async (): Promise<void> => {
    const sequence = ++refreshSequenceRef.current
    setIsLoading(true)
    const results = await Promise.all(
      supportedRepositories.map(async (repository) => {
        const request = getRepoOpenPrs(repository.remoteKind, {
          folderPath: repository.path
        })
        if (!request) return { repository, prs: [] as RepoPr[], error: null as string | null }
        try {
          const result = await request
          return result.ok
            ? { repository, prs: result.prs, error: null }
            : {
                repository,
                prs: [] as RepoPr[],
                error: result.message ?? result.code
              }
        } catch (error) {
          return {
            repository,
            prs: [] as RepoPr[],
            error: error instanceof Error ? error.message : 'Failed to load pull requests'
          }
        }
      })
    )
    if (sequence !== refreshSequenceRef.current) return

    setItems(
      results
        .flatMap(({ repository, prs }) =>
          prs
            .filter((pr) => pr.category === 'assigned')
            .map((pr) => ({ key: reviewKey(repository, pr), repository, pr }))
        )
        .sort((left, right) => (right.pr.createdAt ?? '').localeCompare(left.pr.createdAt ?? ''))
    )
    setErrors(
      results.flatMap(({ repository, error }) => (error ? [`${repository.name}: ${error}`] : []))
    )
    setIsLoading(false)
  }, [supportedRepositories])

  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [repositoryKey, refresh])

  return { items, errors, isLoading, refresh }
}
