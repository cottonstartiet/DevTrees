import * as React from 'react'

import {
  AUTO_REVIEW_REFRESH_INTERVAL_MS,
  autoReviewKey,
  processAutoReviews,
  type AutoReviewStatus
} from '@/lib/auto-reviews'
import { buildCodeReviewPrompt, CODE_REVIEW_INITIAL_MODE } from '@/lib/copilot-code-review-prompt'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { findPrSourceWorktree, newestPrFirst } from '@/lib/dashboard-prs'
import { getRepoOpenPrs } from '@/lib/reviews'
import { listWorktreesForRepository } from '@/lib/worktrees'
import type { RepoPr } from '@shared/reviews'
import type { Repository } from '@shared/repository'
import type { Worktree } from '@shared/worktree'

export type DashboardAssignedPr = {
  key: string
  repository: Repository
  pr: RepoPr
  autoReviewStatus: AutoReviewStatus
}

export type DashboardAuthoredPr = {
  key: string
  repository: Repository
  pr: RepoPr
  sourceWorktree: Worktree | null
  worktreeLookupFailed: boolean
}

export type DashboardPrReviews = {
  assignedItems: DashboardAssignedPr[]
  authoredItems: DashboardAuthoredPr[]
  errors: string[]
  isLoading: boolean
  refresh: () => Promise<void>
}

export function useDashboardPrReviews(repositories: Repository[]): DashboardPrReviews {
  const launchCopilot = useCopilotLauncher()
  const [assignedItems, setAssignedItems] = React.useState<
    Omit<DashboardAssignedPr, 'autoReviewStatus'>[]
  >([])
  const [authoredItems, setAuthoredItems] = React.useState<DashboardAuthoredPr[]>([])
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
        if (!request) {
          return {
            repository,
            prs: [] as RepoPr[],
            worktrees: [] as Worktree[],
            error: null as string | null,
            worktreeError: null as string | null
          }
        }
        const worktreesPromise = listWorktreesForRepository(repository.path)
          .then((worktrees) => ({ worktrees, error: null as string | null }))
          .catch((error: unknown) => ({
            worktrees: [] as Worktree[],
            error: error instanceof Error ? error.message : 'Failed to inspect local worktrees'
          }))
        try {
          const result = await request
          const worktreeResult = await worktreesPromise
          return result.ok
            ? {
                repository,
                prs: result.prs,
                worktrees: worktreeResult.worktrees,
                error: null,
                worktreeError: worktreeResult.error
              }
            : {
                repository,
                prs: [] as RepoPr[],
                worktrees: worktreeResult.worktrees,
                error: result.message ?? result.code,
                worktreeError: worktreeResult.error
              }
        } catch (error) {
          const worktreeResult = await worktreesPromise
          return {
            repository,
            prs: [] as RepoPr[],
            worktrees: worktreeResult.worktrees,
            error: error instanceof Error ? error.message : 'Failed to load pull requests',
            worktreeError: worktreeResult.error
          }
        }
      })
    )
    if (sequence !== refreshSequenceRef.current) return

    const nextAssignedItems = results
      .flatMap(({ repository, prs }) =>
        prs
          .filter((pr) => pr.category === 'assigned')
          .map((pr) => ({
            key: autoReviewKey(repository.path, pr.provider, pr.id),
            repository,
            pr
          }))
      )
      .sort((left, right) => newestPrFirst(left.pr, right.pr))

    const nextAuthoredItems = results
      .flatMap(({ repository, prs, worktrees, worktreeError }) =>
        prs
          .filter((pr) => pr.category === 'mine')
          .map((pr) => ({
            key: autoReviewKey(repository.path, pr.provider, pr.id),
            repository,
            pr,
            sourceWorktree: findPrSourceWorktree(pr, worktrees),
            worktreeLookupFailed: worktreeError !== null
          }))
      )
      .sort((left, right) => newestPrFirst(left.pr, right.pr))

    setAssignedItems(nextAssignedItems)
    setAuthoredItems(nextAuthoredItems)
    setLoadErrors(
      results.flatMap(({ repository, prs, error, worktreeError }) => [
        ...(error ? [`${repository.name}: ${error}`] : []),
        ...(worktreeError && prs.some((pr) => pr.category === 'mine')
          ? [`${repository.name}: Could not inspect local worktrees: ${worktreeError}`]
          : [])
      ])
    )
    setIsLoading(false)

    const activeKeys = new Set(nextAssignedItems.map((item) => item.key))
    setAutomationErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => activeKeys.has(key)))
    )
    setAutomationByKey((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => activeKeys.has(key)))
    )

    const automationFailures = await processAutoReviews(
      nextAssignedItems,
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
          prompt: buildCodeReviewPrompt({
            kind: 'pull-request',
            folderPath: item.repository.path,
            provider: item.pr.provider,
            prNumber: item.pr.id,
            prTitle: item.pr.title,
            prWebUrl: item.pr.webUrl,
            sourceRef: item.pr.sourceRef,
            targetRef: item.pr.targetRef
          }),
          initialMode: CODE_REVIEW_INITIAL_MODE,
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
        nextAssignedItems.flatMap((item) => {
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

  const assignedItemsWithStatus = React.useMemo(
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

  return {
    assignedItems: assignedItemsWithStatus,
    authoredItems,
    errors,
    isLoading,
    refresh
  }
}
