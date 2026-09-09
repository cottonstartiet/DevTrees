import * as React from 'react'

import {
  AUTO_REVIEW_REFRESH_INTERVAL_MS,
  autoReviewKey,
  processAutoReviews,
  type AutoReviewStatus
} from '@/lib/auto-reviews'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { buildPrCodeReviewPrompt } from '@/lib/copilot-pr-review-prompt'
import { getRepoOpenPrs } from '@/lib/reviews'
import type { RepoPr } from '@shared/reviews'
import type { Repository } from '@shared/repository'

export type DashboardAssignedPr = {
  key: string
  repository: Repository
  pr: RepoPr
  autoReviewStatus: AutoReviewStatus
}

export type DashboardPrReviews = {
  items: DashboardAssignedPr[]
  errors: string[]
  isLoading: boolean
  refresh: () => Promise<void>
}

export function useDashboardPrReviews(repositories: Repository[]): DashboardPrReviews {
  const launchCopilot = useCopilotLauncher()
  const [assignedItems, setAssignedItems] = React.useState<
    Omit<DashboardAssignedPr, 'autoReviewStatus'>[]
  >([])
  const [loadErrors, setLoadErrors] = React.useState<string[]>([])
  const [automationErrors, setAutomationErrors] = React.useState<Record<string, string>>({})
  const [automationByKey, setAutomationByKey] = React.useState<Record<string, AutoReviewStatus>>({})
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

    const nextItems = results
      .flatMap(({ repository, prs }) =>
        prs
          .filter((pr) => pr.category === 'assigned')
          .map((pr) => ({
            key: autoReviewKey(repository.path, pr.provider, pr.id),
            repository,
            pr
          }))
      )
      .sort((left, right) => (right.pr.createdAt ?? '').localeCompare(left.pr.createdAt ?? ''))

    setAssignedItems(nextItems)
    setLoadErrors(
      results.flatMap(({ repository, error }) => (error ? [`${repository.name}: ${error}`] : []))
    )
    setIsLoading(false)

    const activeKeys = new Set(nextItems.map((item) => item.key))
    setAutomationErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => activeKeys.has(key)))
    )
    setAutomationByKey((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => activeKeys.has(key)))
    )

    const automationFailures = await processAutoReviews(
      nextItems,
      async (item) =>
        (
          await window.api.reviews.claimAutoReview({
            repositoryPath: item.repository.path,
            provider: item.pr.provider,
            pullRequestId: item.pr.id
          })
        ).claimed,
      async (item) =>
        launchCopilot({
          folderPath: item.repository.path,
          prompt: buildPrCodeReviewPrompt({
            folderPath: item.repository.path,
            provider: item.pr.provider,
            prNumber: item.pr.id,
            prTitle: item.pr.title,
            prWebUrl: item.pr.webUrl,
            sourceRef: item.pr.sourceRef,
            targetRef: item.pr.targetRef
          }),
          label: `Review PR #${item.pr.id}`,
          repository: item.repository.name,
          background: true
        }),
      (item, status) => {
        setAutomationByKey((current) => ({ ...current, [item.key]: status }))
      }
    )
    setAutomationErrors(
      Object.fromEntries(
        nextItems.flatMap((item) => {
          const error = automationFailures[item.key]
          return error ? [[item.key, `${item.repository.name} #${item.pr.id}: ${error}`]] : []
        })
      )
    )
  }, [launchCopilot, supportedRepositories])

  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })
    const interval = window.setInterval(() => void refresh(), AUTO_REVIEW_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [repositoryKey, refresh])

  const items = React.useMemo(
    () =>
      assignedItems.map((item) => ({
        ...item,
        autoReviewStatus: automationByKey[item.key] ?? 'checking'
      })),
    [assignedItems, automationByKey]
  )
  const errors = React.useMemo(
    () => [...loadErrors, ...Object.values(automationErrors)],
    [automationErrors, loadErrors]
  )

  return { items, errors, isLoading, refresh }
}
