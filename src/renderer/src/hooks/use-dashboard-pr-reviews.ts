import * as React from 'react'

import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import { buildPrCodeReviewPrompt } from '@/lib/copilot-pr-review-prompt'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { getRepoOpenPrs } from '@/lib/reviews'
import type { RepoPr } from '@shared/reviews'
import type { Repository } from '@shared/repository'
import type { TerminalSession } from '@shared/terminal-session'

const REFRESH_INTERVAL_MS = 5 * 60 * 1000

export type DashboardReviewState = 'queued' | 'running' | 'completed' | 'error'

export type DashboardReviewRecord = {
  key: string
  state: DashboardReviewState
  /** The Copilot CLI session running the review, for linking to the Sessions view. */
  sessionId: string
  triggeredAt: number
  completedAt?: number
  error?: string
}

export type DashboardAssignedPr = {
  key: string
  repository: Repository
  pr: RepoPr
  review?: DashboardReviewRecord
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

/**
 * Reviews run as ordinary terminal sessions, which carry no PR metadata of their own. The
 * label is therefore the link back to the PR, and is matched together with the folder so
 * a review is recognized again after a restart.
 */
function reviewLabel(pr: RepoPr): string {
  return `Review PR #${pr.id}`
}

function sessionKey(session: TerminalSession): string | null {
  const match = session.label.match(/^Review PR #(.+)$/)
  if (!match) return null
  return `${session.folderPath.toLowerCase()}::${match[1]}`
}

function reviewRecord(key: string, session: TerminalSession): DashboardReviewRecord {
  const state: DashboardReviewState =
    session.status === 'error'
      ? 'error'
      : session.status === 'idle' || session.status === 'done'
        ? 'completed'
        : session.status === 'starting'
          ? 'queued'
          : 'running'
  return {
    key,
    state,
    sessionId: session.id,
    triggeredAt: session.createdAt,
    completedAt: state === 'completed' ? session.updatedAt : undefined,
    error: session.status === 'error' ? session.lastActivity : undefined
  }
}

export function useDashboardPrReviews(repositories: Repository[]): DashboardPrReviews {
  const { sessions } = useTerminalSessions()
  const launch = useCopilotLauncher()
  const [assigned, setAssigned] = React.useState<
    Array<{ key: string; repository: Repository; pr: RepoPr }>
  >([])
  const [errors, setErrors] = React.useState<string[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const refreshSequenceRef = React.useRef(0)
  const launchingRef = React.useRef(new Set<string>())

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

    setAssigned(
      results.flatMap(({ repository, prs }) =>
        prs
          .filter((pr) => pr.category === 'assigned')
          .map((pr) => ({ key: reviewKey(repository, pr), repository, pr }))
      )
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

  const sessionsByKey = React.useMemo(() => {
    const result = new Map<string, TerminalSession>()
    for (const session of sessions) {
      const key = sessionKey(session)
      // `reviewKey` embeds the provider; the label only has the PR id, so match on the
      // folder + id suffix instead of an exact key.
      if (key) result.set(key, session)
    }
    return result
  }, [sessions])

  const lookup = React.useCallback(
    (repository: Repository, pr: RepoPr): TerminalSession | undefined =>
      sessionsByKey.get(`${repository.path.toLowerCase()}::${pr.id}`),
    [sessionsByKey]
  )

  const startReview = React.useCallback(
    async (item: { key: string; repository: Repository; pr: RepoPr }): Promise<void> => {
      if (lookup(item.repository, item.pr) || launchingRef.current.has(item.key)) return
      launchingRef.current.add(item.key)
      const prompt = buildPrCodeReviewPrompt({
        folderPath: item.repository.path,
        provider: item.pr.provider,
        prNumber: item.pr.id,
        prTitle: item.pr.title,
        prWebUrl: item.pr.webUrl,
        sourceRef: item.pr.sourceRef,
        targetRef: item.pr.targetRef
      })
      try {
        await launch({
          folderPath: item.repository.path,
          prompt,
          label: reviewLabel(item.pr),
          branch: item.pr.sourceRef,
          repository: item.repository.name
        })
      } finally {
        launchingRef.current.delete(item.key)
      }
    },
    [launch, lookup]
  )

  React.useEffect(() => {
    let cancelled = false
    const pending = assigned.filter(
      (item) => !lookup(item.repository, item.pr) && !launchingRef.current.has(item.key)
    )
    queueMicrotask(async () => {
      for (const item of pending) {
        if (cancelled) return
        await startReview(item)
      }
    })
    return () => {
      cancelled = true
    }
  }, [assigned, lookup, startReview])

  const items = React.useMemo(
    () =>
      assigned
        .map((item) => {
          const session = lookup(item.repository, item.pr)
          return {
            ...item,
            review: session ? reviewRecord(item.key, session) : undefined
          }
        })
        .sort((left, right) => {
          const leftRank = left.review ? 1 : 0
          const rightRank = right.review ? 1 : 0
          if (leftRank !== rightRank) return leftRank - rightRank
          return (right.pr.createdAt ?? '').localeCompare(left.pr.createdAt ?? '')
        }),
    [assigned, lookup]
  )

  return { items, errors, isLoading, refresh }
}
