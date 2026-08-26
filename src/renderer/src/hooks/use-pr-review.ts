import * as React from 'react'

import type {
  PrChangedFile,
  PrCommentAnchor,
  PrFileContent,
  PrFileDiff,
  PrFileSide,
  PrReviewDetail,
  PrVote
} from '@shared/pr-review'
import type { RepoPrThread } from '@shared/reviews'
import {
  createPrThread,
  getPrChangedFiles,
  getPrDetail,
  getPrFileContent,
  getPrFileDiff,
  replyToPrThread,
  setPrThreadStatus,
  setPrVote,
  type ReviewRemoteKind
} from '@/lib/pr-review'
import { usePrThreads } from '@/hooks/use-pr-threads'

export type PrReviewTarget = {
  folderPath: string
  remoteKind: ReviewRemoteKind
  pullRequestId: number
}

/** Per-file lazily-loaded payload, kept per PR so switching files never refetches. */
type FileEntry<T> = { data: T | null; error: string | null; isLoading: boolean }

/** Added/removed line counts derived from a loaded diff. */
export type PrDiffStats = { additions: number; deletions: number }

function countChanges(diff: PrFileDiff): PrDiffStats {
  let additions = 0
  let deletions = 0
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions += 1
      else if (line.kind === 'del') deletions += 1
    }
  }
  return { additions, deletions }
}

const EMPTY_ENTRY: FileEntry<never> = { data: null, error: null, isLoading: true }

export interface UsePrReviewResult {
  detail: PrReviewDetail | null
  files: PrChangedFile[]
  threads: RepoPrThread[]
  /** Add/delete counts for files whose diff has been loaded. */
  diffStats: Map<string, PrDiffStats>
  error: string | null
  isLoading: boolean
  isMutating: boolean
  /** Cached diff for `path`; call `ensureFileDiff` to load it. */
  fileDiffFor: (path: string | null) => FileEntry<PrFileDiff>
  ensureFileDiff: (path: string) => void
  /** Cached text of one side of `path`; call `ensureFileContent` to load it. */
  fileContentFor: (path: string | null, side: PrFileSide) => FileEntry<PrFileContent>
  ensureFileContent: (path: string, side: PrFileSide) => void
  refresh: () => Promise<void>
  refreshThreads: () => Promise<void>
  createThread: (anchor: PrCommentAnchor | null, content: string) => Promise<string | null>
  reply: (thread: RepoPrThread, content: string) => Promise<string | null>
  setThreadResolved: (thread: RepoPrThread, resolved: boolean) => Promise<string | null>
  vote: (vote: PrVote, content?: string) => Promise<string | null>
}

function failureMessage(result: { code: string; message?: string }): string {
  return result.message ?? result.code
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

/**
 * Controller for the in-app review workspace: PR detail, changed files, comment threads, and the
 * four review mutations.
 *
 * Per-file diffs and blobs load lazily and are cached for the lifetime of the PR key, so moving
 * through the file list stays instant. Mutations are fire-and-refetch — providers do not return a
 * thread shape we can trust to merge locally, and a refetch is the only way to honour the
 * "show true state" principle.
 */
export function usePrReview(target: PrReviewTarget | null): UsePrReviewResult {
  const key = target ? `${target.folderPath}::${target.pullRequestId}` : null

  const [snapshot, setSnapshot] = React.useState<{
    key: string | null
    detail: PrReviewDetail | null
    files: PrChangedFile[]
    error: string | null
  }>({ key: null, detail: null, files: [], error: null })
  const [isLoading, setIsLoading] = React.useState(false)
  const [isMutating, setIsMutating] = React.useState(false)
  const activeKeyRef = React.useRef<string | null>(null)

  const {
    data: threadsData,
    error: threadsError,
    refresh: refreshThreads
  } = usePrThreads(
    target?.folderPath ?? null,
    target?.remoteKind ?? null,
    target?.pullRequestId ?? null,
    Boolean(target),
    true
  )

  // Per-file caches. A version counter re-renders consumers when an entry settles, which keeps the
  // cache in a ref (stable across renders) instead of cloning a Map into state on every load.
  // The caches carry the PR key they belong to and reset lazily on first use after a PR change,
  // so switching PRs never leaks another PR's diffs.
  const caches = React.useRef({
    key: null as string | null,
    diff: new Map<string, FileEntry<PrFileDiff>>(),
    content: new Map<string, FileEntry<PrFileContent>>()
  })
  const [cacheVersion, setCacheVersion] = React.useState(0)
  // Add/delete counts per file, filled in as diffs load. Providers that do not report them in the
  // change list (Azure DevOps) get accurate counts for every file the reviewer has opened.
  const [diffStats, setDiffStats] = React.useState<{
    key: string | null
    map: Map<string, PrDiffStats>
  }>({ key: null, map: new Map() })

  const cachesFor = React.useCallback((current: string | null) => {
    if (caches.current.key !== current) {
      caches.current = { key: current, diff: new Map(), content: new Map() }
    }
    return caches.current
  }, [])

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!target || !key) return
    setIsLoading(true)
    try {
      const [detailResult, filesResult] = await Promise.all([
        getPrDetail(target.remoteKind, {
          folderPath: target.folderPath,
          pullRequestId: target.pullRequestId
        }),
        getPrChangedFiles(target.remoteKind, {
          folderPath: target.folderPath,
          pullRequestId: target.pullRequestId
        })
      ])
      if (activeKeyRef.current !== key) return

      if (!detailResult.ok) {
        setSnapshot({ key, detail: null, files: [], error: failureMessage(detailResult) })
        return
      }
      setSnapshot({
        key,
        detail: detailResult.detail,
        files: filesResult.ok ? filesResult.files : [],
        error: filesResult.ok ? null : failureMessage(filesResult)
      })
    } catch (err) {
      if (activeKeyRef.current !== key) return
      setSnapshot({
        key,
        detail: null,
        files: [],
        error: errorMessage(err, 'Could not load pull request.')
      })
    } finally {
      setIsLoading(false)
    }
  }, [target, key])

  React.useEffect(() => {
    activeKeyRef.current = key
    if (!key) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })
    return () => {
      cancelled = true
    }
  }, [key, refresh])

  const loadDiff = React.useCallback(
    async (path: string): Promise<void> => {
      if (!target || !key) return
      const cacheKey = path
      cachesFor(key).diff.set(cacheKey, { data: null, error: null, isLoading: true })
      setCacheVersion((v) => v + 1)
      try {
        const result = await getPrFileDiff(target.remoteKind, {
          folderPath: target.folderPath,
          pullRequestId: target.pullRequestId,
          path
        })
        if (activeKeyRef.current !== key) return
        cachesFor(key).diff.set(cacheKey, {
          data: result.ok ? result.diff : null,
          error: result.ok ? null : failureMessage(result),
          isLoading: false
        })
        if (result.ok) {
          const stats = countChanges(result.diff)
          setDiffStats((current) => {
            const map = current.key === key ? new Map(current.map) : new Map<string, PrDiffStats>()
            map.set(path, stats)
            return { key, map }
          })
        }
      } catch (err) {
        if (activeKeyRef.current !== key) return
        cachesFor(key).diff.set(cacheKey, {
          data: null,
          error: errorMessage(err, 'Could not load diff.'),
          isLoading: false
        })
      } finally {
        setCacheVersion((v) => v + 1)
      }
    },
    [target, key, cachesFor]
  )

  const loadContent = React.useCallback(
    async (path: string, side: PrFileSide): Promise<void> => {
      if (!target || !key) return
      const cacheKey = `${side}::${path}`
      cachesFor(key).content.set(cacheKey, { data: null, error: null, isLoading: true })
      setCacheVersion((v) => v + 1)
      try {
        const result = await getPrFileContent(target.remoteKind, {
          folderPath: target.folderPath,
          pullRequestId: target.pullRequestId,
          path,
          side
        })
        if (activeKeyRef.current !== key) return
        cachesFor(key).content.set(cacheKey, {
          data: result.ok ? result.content : null,
          error: result.ok ? null : failureMessage(result),
          isLoading: false
        })
      } catch (err) {
        if (activeKeyRef.current !== key) return
        cachesFor(key).content.set(cacheKey, {
          data: null,
          error: errorMessage(err, 'Could not load file.'),
          isLoading: false
        })
      } finally {
        setCacheVersion((v) => v + 1)
      }
    },
    [target, key, cachesFor]
  )

  const ensureFileDiff = React.useCallback(
    (path: string): void => {
      if (!path || cachesFor(key).diff.has(path)) return
      void loadDiff(path)
    },
    [loadDiff, key, cachesFor]
  )

  const ensureFileContent = React.useCallback(
    (path: string, side: PrFileSide): void => {
      const cacheKey = `${side}::${path}`
      if (!path || cachesFor(key).content.has(cacheKey)) return
      void loadContent(path, side)
    },
    [loadContent, key, cachesFor]
  )

  // `cacheVersion` is read so the lookups below are re-created whenever an entry settles, which is
  // what propagates a finished load to consumers.
  const fileDiffFor = React.useCallback(
    (path: string | null): FileEntry<PrFileDiff> => {
      void cacheVersion
      if (!path) return { data: null, error: null, isLoading: false }
      return cachesFor(key).diff.get(path) ?? EMPTY_ENTRY
    },
    [cacheVersion, key, cachesFor]
  )

  const fileContentFor = React.useCallback(
    (path: string | null, side: PrFileSide): FileEntry<PrFileContent> => {
      void cacheVersion
      if (!path) return { data: null, error: null, isLoading: false }
      return cachesFor(key).content.get(`${side}::${path}`) ?? EMPTY_ENTRY
    },
    [cacheVersion, key, cachesFor]
  )

  const runMutation = React.useCallback(
    async (
      run: () => Promise<{ ok: boolean; code?: string; message?: string }>,
      alsoRefreshDetail = false
    ): Promise<string | null> => {
      setIsMutating(true)
      try {
        const result = await run()
        if (!result.ok) return result.message ?? result.code ?? 'Request failed.'
        await refreshThreads()
        if (alsoRefreshDetail) await refresh()
        return null
      } catch (err) {
        return errorMessage(err, 'Request failed.')
      } finally {
        setIsMutating(false)
      }
    },
    [refresh, refreshThreads]
  )

  const createThread = React.useCallback(
    (anchor: PrCommentAnchor | null, content: string): Promise<string | null> => {
      if (!target) return Promise.resolve('No pull request selected.')
      return runMutation(() =>
        createPrThread(target.remoteKind, {
          folderPath: target.folderPath,
          pullRequestId: target.pullRequestId,
          anchor,
          content
        })
      )
    },
    [target, runMutation]
  )

  const reply = React.useCallback(
    (thread: RepoPrThread, content: string): Promise<string | null> => {
      if (!target) return Promise.resolve('No pull request selected.')
      return runMutation(() =>
        replyToPrThread(target.remoteKind, {
          folderPath: target.folderPath,
          pullRequestId: target.pullRequestId,
          threadId: thread.providerThreadId,
          rootCommentId: thread.id,
          content
        })
      )
    },
    [target, runMutation]
  )

  const setThreadResolved = React.useCallback(
    (thread: RepoPrThread, resolved: boolean): Promise<string | null> => {
      if (!target) return Promise.resolve('No pull request selected.')
      return runMutation(() =>
        setPrThreadStatus(target.remoteKind, {
          folderPath: target.folderPath,
          pullRequestId: target.pullRequestId,
          threadId: thread.providerThreadId,
          resolved
        })
      )
    },
    [target, runMutation]
  )

  const vote = React.useCallback(
    (value: PrVote, content?: string): Promise<string | null> => {
      if (!target) return Promise.resolve('No pull request selected.')
      return runMutation(
        () =>
          setPrVote(target.remoteKind, {
            folderPath: target.folderPath,
            pullRequestId: target.pullRequestId,
            vote: value,
            content
          }),
        true
      )
    },
    [target, runMutation]
  )

  const isCurrent = snapshot.key === key

  return {
    detail: isCurrent ? snapshot.detail : null,
    files: isCurrent ? snapshot.files : [],
    threads: threadsData?.threads ?? [],
    diffStats: diffStats.key === key ? diffStats.map : new Map(),
    error: (isCurrent ? snapshot.error : null) ?? threadsError,
    isLoading,
    isMutating,
    fileDiffFor,
    ensureFileDiff,
    fileContentFor,
    ensureFileContent,
    refresh,
    refreshThreads,
    createThread,
    reply,
    setThreadResolved,
    vote
  }
}
