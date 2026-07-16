import * as React from 'react'
import { toast } from 'sonner'

import type { Repository } from '@shared/repository'
import type { Worktree, WorktreeStatusResult } from '@shared/worktree'
import { useTasks } from '@/contexts/tasks-context'
import {
  listRepositories,
  pickAndAddRepository,
  removeRepository as removeRepositoryIpc,
  reorderRepositories as reorderRepositoriesIpc
} from '@/lib/repositories'
import { createBranch as createBranchIpc } from '@/lib/repo'
import {
  createWorktree as createWorktreeIpc,
  deleteWorktree as deleteWorktreeIpc,
  getWorktreeStatus as getWorktreeStatusIpc,
  listWorktreesForRepository
} from '@/lib/worktrees'

export interface UseRepositoriesResult {
  repositories: Repository[]
  worktreesByRepositoryId: Record<string, Worktree[]>
  activeId: string | null
  deletingWorktreePaths: ReadonlySet<string>
  selectRepository: (id: string | null) => void
  addRepository: () => Promise<void>
  removeRepository: (id: string) => Promise<void>
  reorderRepositories: (orderedIds: string[]) => Promise<void>
  refreshWorktreesFor: (repositoryId: string) => Promise<void>
  createWorktree: (repository: Repository, name: string) => Promise<boolean>
  createBranchInWorktree: (
    repository: Repository,
    worktree: Worktree,
    fullBranchName: string
  ) => Promise<boolean>
  deleteWorktree: (repository: Repository, worktree: Worktree) => Promise<boolean>
  checkWorktreeStatus: (worktreePath: string) => Promise<WorktreeStatusResult>
}

export function useRepositories(): UseRepositoriesResult {
  const [repositories, setRepositories] = React.useState<Repository[]>([])
  const [worktreesByRepositoryId, setWorktreesByRepositoryId] = React.useState<
    Record<string, Worktree[]>
  >({})
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [deletingWorktreePaths, setDeletingWorktreePaths] = React.useState<ReadonlySet<string>>(
    () => new Set<string>()
  )
  const { startTask, succeedTask, failTask } = useTasks()

  // Always-current snapshot of repositories for effects keyed on the repository *set*
  // (not its order), so reordering never triggers a worktree refetch.
  const repositoriesRef = React.useRef(repositories)
  React.useEffect(() => {
    repositoriesRef.current = repositories
  })
  const repositorySetKey = React.useMemo(
    () =>
      repositories
        .map((w) => `${w.id}::${w.path}`)
        .sort()
        .join('|'),
    [repositories]
  )

  React.useEffect(() => {
    let cancelled = false
    listRepositories()
      .then((list) => {
        if (!cancelled) setRepositories(list)
      })
      .catch((err) => {
        console.error('[repositories] failed to load list:', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    const current = repositoriesRef.current
    if (current.length === 0) {
      return () => {
        cancelled = true
      }
    }

    Promise.allSettled(
      current.map((ws) => listWorktreesForRepository(ws.path).then((wts) => ({ id: ws.id, wts })))
    ).then((results) => {
      if (cancelled) return
      const next: Record<string, Worktree[]> = {}
      results.forEach((r, idx) => {
        const ws = current[idx]
        if (r.status === 'fulfilled') {
          next[r.value.id] = r.value.wts.filter((w) => !w.isMain)
        } else {
          next[ws.id] = []
        }
      })
      setWorktreesByRepositoryId(next)
    })

    return () => {
      cancelled = true
    }
  }, [repositorySetKey])

  const addRepository = React.useCallback(async (): Promise<void> => {
    const ws = await pickAndAddRepository()
    if (ws) {
      setRepositories((prev) => [...prev, ws])
      setActiveId(ws.id)
    }
  }, [])

  const removeRepository = React.useCallback(async (id: string): Promise<void> => {
    const next = await removeRepositoryIpc(id)
    setRepositories(next)
    setWorktreesByRepositoryId((prev) => {
      if (!(id in prev)) return prev
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    setActiveId((current) => (current === id ? null : current))
  }, [])

  const selectRepository = React.useCallback((id: string | null): void => {
    setActiveId(id)
  }, [])

  const reorderSeqRef = React.useRef(0)
  const reorderRepositories = React.useCallback(async (orderedIds: string[]): Promise<void> => {
    const seq = ++reorderSeqRef.current
    const previous = repositoriesRef.current
    setRepositories((prev) => {
      const byId = new Map(prev.map((w) => [w.id, w]))
      const next = orderedIds
        .map((id) => byId.get(id))
        .filter((w): w is Repository => w !== undefined)
      // Safety: keep any repository missing from orderedIds, preserving prior order.
      for (const w of prev) {
        if (!orderedIds.includes(w.id)) next.push(w)
      }
      return next
    })
    try {
      const updated = await reorderRepositoriesIpc(orderedIds)
      // Ignore stale responses if a newer reorder has since been issued.
      if (seq === reorderSeqRef.current) setRepositories(updated)
    } catch (err) {
      console.error('[repositories] reorder failed:', err)
      if (seq === reorderSeqRef.current) {
        setRepositories(previous)
        toast.error('Could not save repository order.')
      }
    }
  }, [])

  const refreshWorktreesFor = React.useCallback(
    async (repositoryId: string): Promise<void> => {
      const ws = repositories.find((w) => w.id === repositoryId)
      if (!ws) return
      try {
        const list = await listWorktreesForRepository(ws.path)
        setWorktreesByRepositoryId((prev) => ({
          ...prev,
          [repositoryId]: list.filter((w) => !w.isMain)
        }))
      } catch (err) {
        console.error('[worktrees] refresh failed:', err)
      }
    },
    [repositories]
  )

  const createWorktree = React.useCallback(
    async (repository: Repository, name: string): Promise<boolean> => {
      const taskId = startTask(`Creating worktree "${name}" in ${repository.name}`)
      try {
        const result = await createWorktreeIpc({
          repositoryId: repository.id,
          repositoryPath: repository.path,
          name
        })
        if (result.ok) {
          succeedTask(taskId)
          toast.success(`Worktree "${name}" created`)
          await refreshWorktreesFor(repository.id)
          return true
        }
        const message =
          result.message ??
          (result.error === 'invalid-name'
            ? 'Invalid worktree name.'
            : result.error === 'already-exists'
              ? 'A folder with that name already exists.'
              : 'Failed to create worktree.')
        failTask(taskId, message)
        toast.error(message)
        return false
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create worktree.'
        failTask(taskId, message)
        toast.error(message)
        return false
      }
    },
    [startTask, succeedTask, failTask, refreshWorktreesFor]
  )

  const worktreeLabel = (path: string): string => {
    const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
    return idx < 0 ? path : path.slice(idx + 1)
  }

  const createBranchInWorktree = React.useCallback(
    async (
      repository: Repository,
      worktree: Worktree,
      fullBranchName: string
    ): Promise<boolean> => {
      const label = worktreeLabel(worktree.path)
      const taskId = startTask(
        `Creating branch "${fullBranchName}" in ${repository.name} / ${label}`
      )
      try {
        const result = await createBranchIpc({
          folderPath: worktree.path,
          name: fullBranchName
        })
        if (result.ok) {
          succeedTask(taskId)
          toast.success(`Branch "${result.branch}" created`)
          await refreshWorktreesFor(repository.id)
          return true
        }
        const message =
          result.message ??
          (result.error === 'invalid-name'
            ? 'Invalid branch name.'
            : result.error === 'already-exists'
              ? `Branch "${fullBranchName}" already exists.`
              : 'Failed to create branch.')
        failTask(taskId, message)
        toast.error(message)
        return false
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create branch.'
        failTask(taskId, message)
        toast.error(message)
        return false
      }
    },
    [startTask, succeedTask, failTask, refreshWorktreesFor]
  )

  const deleteWorktree = React.useCallback(
    async (repository: Repository, worktree: Worktree): Promise<boolean> => {
      const label = worktreeLabel(worktree.path)
      setDeletingWorktreePaths((prev) => {
        const next = new Set(prev)
        next.add(worktree.path)
        return next
      })
      const taskId = startTask(`Deleting worktree "${label}" in ${repository.name}`)
      try {
        const result = await deleteWorktreeIpc({
          repositoryPath: repository.path,
          worktreePath: worktree.path
        })
        if (result.ok) {
          succeedTask(taskId)
          toast.success(`Worktree "${label}" deleted`)
          await refreshWorktreesFor(repository.id)
          return true
        }
        const message =
          result.message ??
          (result.error === 'is-main'
            ? 'Cannot delete the main worktree.'
            : result.error === 'is-locked'
              ? 'Worktree is locked.'
              : result.error === 'has-changes'
                ? 'Worktree has uncommitted changes.'
                : result.error === 'unreachable-commits'
                  ? 'Worktree has commits not reachable from any branch.'
                  : result.error === 'not-found'
                    ? 'Worktree is not registered.'
                    : 'Failed to delete worktree.')
        failTask(taskId, message)
        toast.error(message)
        return false
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete worktree.'
        failTask(taskId, message)
        toast.error(message)
        return false
      } finally {
        setDeletingWorktreePaths((prev) => {
          if (!prev.has(worktree.path)) return prev
          const next = new Set(prev)
          next.delete(worktree.path)
          return next
        })
      }
    },
    [startTask, succeedTask, failTask, refreshWorktreesFor]
  )

  const checkWorktreeStatus = React.useCallback(
    async (worktreePath: string): Promise<WorktreeStatusResult> => {
      try {
        return await getWorktreeStatusIpc(worktreePath)
      } catch (err) {
        return {
          ok: false,
          error: 'unknown',
          message: err instanceof Error ? err.message : 'Failed to check worktree status.'
        }
      }
    },
    []
  )

  return {
    repositories,
    worktreesByRepositoryId,
    activeId,
    deletingWorktreePaths,
    selectRepository,
    addRepository,
    removeRepository,
    reorderRepositories,
    refreshWorktreesFor,
    createWorktree,
    createBranchInWorktree,
    deleteWorktree,
    checkWorktreeStatus
  }
}
