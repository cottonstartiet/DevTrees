import * as React from 'react'

import { useSessions } from '@/contexts/sessions-context'
import { buildPrCodeReviewPrompt } from '@/lib/copilot-pr-review-prompt'
import { getRepoOpenPrs } from '@/lib/reviews'
import { cleanTerminalOutput } from '@/lib/terminal-output'
import type { RepoPr } from '@shared/reviews'
import type { Repository } from '@shared/repository'

const STORAGE_KEY = 'devtrees.dashboard-pr-reviews.v1'
const REFRESH_INTERVAL_MS = 5 * 60 * 1000
const MAX_REVIEW_OUTPUT_CHARS = 20_000

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

function loadReviewRecords(): Record<string, DashboardReviewRecord> {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (!value) return {}
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, DashboardReviewRecord>)
      : {}
  } catch (error) {
    console.warn('[dashboard] could not load PR review state:', error)
    return {}
  }
}

function persistReviewRecords(records: Record<string, DashboardReviewRecord>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  } catch (error) {
    console.warn('[dashboard] could not persist PR review state:', error)
  }
}

function tail(text: string, length: number): string {
  return text.length > length ? text.slice(text.length - length) : text
}

export function useDashboardPrReviews(repositories: Repository[]): DashboardPrReviews {
  const { sessions, activityBySessionId, createSession, snapshot } = useSessions()
  const [assigned, setAssigned] = React.useState<
    Array<{ key: string; repository: Repository; pr: RepoPr }>
  >([])
  const [records, setRecords] =
    React.useState<Record<string, DashboardReviewRecord>>(loadReviewRecords)
  const [errors, setErrors] = React.useState<string[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const recordsRef = React.useRef(records)
  const refreshSequenceRef = React.useRef(0)
  const launchingRef = React.useRef(new Set<string>())
  const completingRef = React.useRef(new Set<string>())

  const commitRecords = React.useCallback(
    (
      update: (
        current: Record<string, DashboardReviewRecord>
      ) => Record<string, DashboardReviewRecord>
    ): void => {
      setRecords((current) => {
        const next = update(current)
        recordsRef.current = next
        persistReviewRecords(next)
        return next
      })
    },
    []
  )

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

  const startReview = React.useCallback(
    async (item: { key: string; repository: Repository; pr: RepoPr }): Promise<void> => {
      if (recordsRef.current[item.key] || launchingRef.current.has(item.key)) return
      launchingRef.current.add(item.key)
      const queued: DashboardReviewRecord = {
        key: item.key,
        state: 'queued',
        triggeredAt: Date.now()
      }
      commitRecords((current) => ({ ...current, [item.key]: queued }))

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
        const result = await createSession(
          {
            folderPath: item.repository.path,
            prompt,
            label: `Review PR #${item.pr.id}`,
            branch: item.pr.sourceRef,
            repository: item.repository.name
          },
          { activate: false }
        )
        commitRecords((current) => ({
          ...current,
          [item.key]: result.ok
            ? { ...queued, state: 'running', sessionId: result.session.id }
            : { ...queued, state: 'error', error: result.error, completedAt: Date.now() }
        }))
      } catch (error) {
        commitRecords((current) => ({
          ...current,
          [item.key]: {
            ...queued,
            state: 'error',
            error: error instanceof Error ? error.message : 'Could not start Copilot review',
            completedAt: Date.now()
          }
        }))
      } finally {
        launchingRef.current.delete(item.key)
      }
    },
    [commitRecords, createSession]
  )

  React.useEffect(() => {
    let cancelled = false
    const pending = assigned.filter(
      (item) => !recordsRef.current[item.key] && !launchingRef.current.has(item.key)
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
  }, [assigned, startReview])

  React.useEffect(() => {
    for (const record of Object.values(records)) {
      if (record.state !== 'running' || !record.sessionId) continue
      const session = sessions.find((candidate) => candidate.id === record.sessionId)
      const completed =
        session?.status === 'exited' ||
        activityBySessionId[record.sessionId]?.attentionKind === 'command'
      if (!session || !completed || completingRef.current.has(record.key)) continue

      completingRef.current.add(record.key)
      void snapshot(record.sessionId)
        .then((sessionSnapshot) => {
          const raw = sessionSnapshot
            ? new TextDecoder('utf-8', { fatal: false }).decode(sessionSnapshot.buffer)
            : ''
          const output = tail(cleanTerminalOutput(raw).trim(), MAX_REVIEW_OUTPUT_CHARS)
          commitRecords((current) => ({
            ...current,
            [record.key]: {
              ...record,
              state:
                session.status === 'exited' && (session.exitCode ?? 0) !== 0
                  ? 'error'
                  : 'completed',
              completedAt: Date.now(),
              output,
              error:
                session.status === 'exited' && (session.exitCode ?? 0) !== 0
                  ? `Copilot exited with code ${session.exitCode ?? 0}.`
                  : undefined
            }
          }))
        })
        .catch((error) => {
          commitRecords((current) => ({
            ...current,
            [record.key]: {
              ...record,
              state: 'error',
              completedAt: Date.now(),
              error:
                error instanceof Error ? error.message : 'Could not read the review session output.'
            }
          }))
        })
        .finally(() => completingRef.current.delete(record.key))
    }
  }, [activityBySessionId, commitRecords, records, sessions, snapshot])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      const sessionIds = new Set(sessions.map((session) => session.id))
      commitRecords((current) => {
        let changed = false
        const next = { ...current }
        for (const [key, record] of Object.entries(current)) {
          if (record.state === 'running' && record.sessionId && !sessionIds.has(record.sessionId)) {
            next[key] = {
              ...record,
              state: 'error',
              completedAt: Date.now(),
              error: 'The Copilot review session is no longer available.'
            }
            changed = true
          }
        }
        return changed ? next : current
      })
    }, 3_000)
    return () => window.clearTimeout(timeout)
  }, [commitRecords, sessions])

  const items = React.useMemo(
    () =>
      assigned
        .map((item) => ({ ...item, review: records[item.key] }))
        .sort((left, right) => {
          const leftRank = left.review ? 1 : 0
          const rightRank = right.review ? 1 : 0
          if (leftRank !== rightRank) return leftRank - rightRank
          return (right.pr.createdAt ?? '').localeCompare(left.pr.createdAt ?? '')
        }),
    [assigned, records]
  )

  return { items, errors, isLoading, refresh }
}
