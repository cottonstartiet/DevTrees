import * as React from 'react'

import { useAgentSessions } from '@/contexts/agent-sessions-context'
import { buildPrCodeReviewPrompt } from '@/lib/copilot-pr-review-prompt'
import { getRepoOpenPrs } from '@/lib/reviews'
import type { AgentSession, AgentSessionEvent, JsonValue } from '@shared/agent-session'
import type { RepoPr } from '@shared/reviews'
import type { Repository } from '@shared/repository'

const REFRESH_INTERVAL_MS = 5 * 60 * 1000

export type DashboardReviewState = 'queued' | 'running' | 'completed' | 'error'

export type DashboardReviewRecord = {
  key: string
  state: DashboardReviewState
  sessionId?: string
  triggeredAt: number
  completedAt?: number
  output?: string
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

function sessionReviewKey(session: AgentSession): string | null {
  if (session.purpose !== 'pr_review' || !session.provider || !session.prId) return null
  return `${session.folderPath.toLowerCase()}::${session.provider}::${session.prId}`
}

function stringField(value: JsonValue, field: string): string | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined
  const candidate = value[field]
  return typeof candidate === 'string' ? candidate : undefined
}

function reviewOutput(events: AgentSessionEvent[]): string | undefined {
  const messages = events
    .filter((event) => event.type === 'assistant.message' && !event.agentId)
    .map((event) => stringField(event.data, 'content')?.trim())
    .filter((value): value is string => !!value)
  return messages.at(-1)
}

function reviewRecord(
  key: string,
  session: AgentSession,
  events: AgentSessionEvent[]
): DashboardReviewRecord {
  const output = reviewOutput(events)
  const completed = events.some((event) => event.type === 'session.idle')
  const state: DashboardReviewState =
    session.lifecycle === 'failed' || (session.lifecycle === 'stopped' && !completed)
      ? 'error'
      : session.lifecycle === 'idle' || completed
        ? 'completed'
        : session.lifecycle === 'initializing'
          ? 'queued'
          : 'running'
  return {
    key,
    state,
    sessionId: session.id,
    triggeredAt: session.createdAt,
    completedAt: session.completedAt,
    output,
    error:
      session.lastError ??
      (session.lifecycle === 'stopped' && !completed
        ? 'Review stopped before Copilot reported completion.'
        : undefined)
  }
}

export function useDashboardPrReviews(repositories: Repository[]): DashboardPrReviews {
  const { reviewSessions, eventsBySessionId, createSession } = useAgentSessions()
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
    const result = new Map<string, AgentSession>()
    for (const session of reviewSessions) {
      const key = sessionReviewKey(session)
      if (key) result.set(key, session)
    }
    return result
  }, [reviewSessions])

  const startReview = React.useCallback(
    async (item: { key: string; repository: Repository; pr: RepoPr }): Promise<void> => {
      if (sessionsByKey.has(item.key) || launchingRef.current.has(item.key)) return
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
        await createSession(
          {
            purpose: 'pr_review',
            folderPath: item.repository.path,
            prompt,
            label: `Review PR #${item.pr.id}`,
            branch: item.pr.sourceRef,
            repository: item.repository.name,
            provider: item.pr.provider,
            prId: String(item.pr.id),
            prTitle: item.pr.title
          },
          { activate: false }
        )
      } finally {
        launchingRef.current.delete(item.key)
      }
    },
    [createSession, sessionsByKey]
  )

  React.useEffect(() => {
    let cancelled = false
    const pending = assigned.filter(
      (item) => !sessionsByKey.has(item.key) && !launchingRef.current.has(item.key)
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
  }, [assigned, sessionsByKey, startReview])

  const items = React.useMemo(
    () =>
      assigned
        .map((item) => {
          const session = sessionsByKey.get(item.key)
          return {
            ...item,
            review: session
              ? reviewRecord(item.key, session, eventsBySessionId[session.id] ?? [])
              : undefined
          }
        })
        .sort((left, right) => {
          const leftRank = left.review ? 1 : 0
          const rightRank = right.review ? 1 : 0
          if (leftRank !== rightRank) return leftRank - rightRank
          return (right.pr.createdAt ?? '').localeCompare(left.pr.createdAt ?? '')
        }),
    [assigned, eventsBySessionId, sessionsByKey]
  )

  return { items, errors, isLoading, refresh }
}
