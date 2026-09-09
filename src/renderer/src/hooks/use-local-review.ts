import * as React from 'react'

import {
  getLocalReviewChangedFiles,
  getLocalReviewFileContent,
  getLocalReviewFileDiff
} from '@/lib/repo'
import type { PrChangedFile, PrFileContent, PrFileDiff } from '@shared/pr-review'

export type LocalReviewTarget = {
  folderPath: string
  branchLabel?: string
}

export type ReviewFileEntry<T> = {
  data: T | null
  error: string | null
  isLoading: boolean
}

export type ReviewDiffStats = { additions: number; deletions: number }

const EMPTY_ENTRY: ReviewFileEntry<never> = { data: null, error: null, isLoading: true }

function countChanges(diff: PrFileDiff): ReviewDiffStats {
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export interface UseLocalReviewResult {
  files: PrChangedFile[]
  diffStats: Map<string, ReviewDiffStats>
  /** Changes whenever refresh invalidates the lazy per-file caches. */
  refreshRevision: number
  error: string | null
  isLoading: boolean
  fileDiffFor: (path: string | null) => ReviewFileEntry<PrFileDiff>
  ensureFileDiff: (path: string) => void
  fileContentFor: (path: string | null) => ReviewFileEntry<PrFileContent>
  ensureFileContent: (path: string) => void
  refresh: () => Promise<void>
}

export function useLocalReview(target: LocalReviewTarget): UseLocalReviewResult {
  const key = target.folderPath
  const activeKeyRef = React.useRef<string | null>(key)
  const requestGenerationRef = React.useRef(0)
  const [snapshot, setSnapshot] = React.useState<{
    key: string
    files: PrChangedFile[]
    error: string | null
  }>({ key, files: [], error: null })
  const [isLoading, setIsLoading] = React.useState(false)
  const caches = React.useRef({
    key,
    generation: 0,
    diff: new Map<string, ReviewFileEntry<PrFileDiff>>(),
    content: new Map<string, ReviewFileEntry<PrFileContent>>()
  })
  const [cacheVersion, setCacheVersion] = React.useState(0)
  const [refreshRevision, setRefreshRevision] = React.useState(0)
  const [diffStats, setDiffStats] = React.useState<{
    key: string
    generation: number
    map: Map<string, ReviewDiffStats>
  }>({ key, generation: 0, map: new Map() })

  const resetCaches = React.useCallback((currentKey: string, generation: number): void => {
    caches.current = {
      key: currentKey,
      generation,
      diff: new Map(),
      content: new Map()
    }
    setDiffStats({ key: currentKey, generation, map: new Map() })
    setRefreshRevision(generation)
    setCacheVersion((version) => version + 1)
  }, [])

  const refresh = React.useCallback(async (): Promise<void> => {
    const generation = requestGenerationRef.current + 1
    requestGenerationRef.current = generation
    resetCaches(key, generation)
    setIsLoading(true)
    try {
      const result = await getLocalReviewChangedFiles({ folderPath: target.folderPath })
      if (activeKeyRef.current !== key || requestGenerationRef.current !== generation) return
      setSnapshot({
        key,
        files: result.ok ? result.files : [],
        error: result.ok ? null : result.error
      })
    } catch (error) {
      if (activeKeyRef.current !== key || requestGenerationRef.current !== generation) return
      setSnapshot({
        key,
        files: [],
        error: errorMessage(error, 'Could not load working-copy changes.')
      })
    } finally {
      if (activeKeyRef.current === key && requestGenerationRef.current === generation) {
        setIsLoading(false)
      }
    }
  }, [key, resetCaches, target.folderPath])

  React.useEffect(() => {
    activeKeyRef.current = key
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })
    return () => {
      cancelled = true
      if (activeKeyRef.current === key) activeKeyRef.current = null
      requestGenerationRef.current += 1
    }
  }, [key, refresh])

  const loadDiff = React.useCallback(
    async (path: string): Promise<void> => {
      const generation = requestGenerationRef.current
      const cache = caches.current
      if (cache.key !== key || cache.generation !== generation) return
      cache.diff.set(path, { data: null, error: null, isLoading: true })
      setCacheVersion((version) => version + 1)
      try {
        const result = await getLocalReviewFileDiff({ folderPath: target.folderPath, path })
        if (activeKeyRef.current !== key || requestGenerationRef.current !== generation) return
        const currentCache = caches.current
        if (currentCache.key !== key || currentCache.generation !== generation) return
        currentCache.diff.set(path, {
          data: result.ok ? result.diff : null,
          error: result.ok ? null : result.error,
          isLoading: false
        })
        if (result.ok) {
          setDiffStats((current) => {
            if (current.key !== key || current.generation !== generation) return current
            const map = new Map(current.map)
            map.set(path, countChanges(result.diff))
            return { ...current, map }
          })
        }
      } catch (error) {
        if (activeKeyRef.current !== key || requestGenerationRef.current !== generation) return
        caches.current.diff.set(path, {
          data: null,
          error: errorMessage(error, 'Could not load diff.'),
          isLoading: false
        })
      } finally {
        if (activeKeyRef.current === key && requestGenerationRef.current === generation) {
          setCacheVersion((version) => version + 1)
        }
      }
    },
    [key, target.folderPath]
  )

  const loadContent = React.useCallback(
    async (path: string): Promise<void> => {
      const generation = requestGenerationRef.current
      const cache = caches.current
      if (cache.key !== key || cache.generation !== generation) return
      cache.content.set(path, { data: null, error: null, isLoading: true })
      setCacheVersion((version) => version + 1)
      try {
        const result = await getLocalReviewFileContent({ folderPath: target.folderPath, path })
        if (activeKeyRef.current !== key || requestGenerationRef.current !== generation) return
        const currentCache = caches.current
        if (currentCache.key !== key || currentCache.generation !== generation) return
        currentCache.content.set(path, {
          data: result.ok ? result.content : null,
          error: result.ok ? null : result.error,
          isLoading: false
        })
      } catch (error) {
        if (activeKeyRef.current !== key || requestGenerationRef.current !== generation) return
        caches.current.content.set(path, {
          data: null,
          error: errorMessage(error, 'Could not load file.'),
          isLoading: false
        })
      } finally {
        if (activeKeyRef.current === key && requestGenerationRef.current === generation) {
          setCacheVersion((version) => version + 1)
        }
      }
    },
    [key, target.folderPath]
  )

  const ensureFileDiff = React.useCallback(
    (path: string): void => {
      if (!path || caches.current.diff.has(path)) return
      void loadDiff(path)
    },
    [loadDiff]
  )

  const ensureFileContent = React.useCallback(
    (path: string): void => {
      if (!path || caches.current.content.has(path)) return
      void loadContent(path)
    },
    [loadContent]
  )

  const fileDiffFor = React.useCallback(
    (path: string | null): ReviewFileEntry<PrFileDiff> => {
      void cacheVersion
      if (!path) return { data: null, error: null, isLoading: false }
      return caches.current.diff.get(path) ?? EMPTY_ENTRY
    },
    [cacheVersion]
  )

  const fileContentFor = React.useCallback(
    (path: string | null): ReviewFileEntry<PrFileContent> => {
      void cacheVersion
      if (!path) return { data: null, error: null, isLoading: false }
      return caches.current.content.get(path) ?? EMPTY_ENTRY
    },
    [cacheVersion]
  )

  const isCurrent = snapshot.key === key

  return {
    files: isCurrent ? snapshot.files : [],
    diffStats: diffStats.key === key ? diffStats.map : new Map(),
    refreshRevision,
    error: isCurrent ? snapshot.error : null,
    isLoading,
    fileDiffFor,
    ensureFileDiff,
    fileContentFor,
    ensureFileContent,
    refresh
  }
}
