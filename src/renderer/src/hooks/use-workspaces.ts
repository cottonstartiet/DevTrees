import * as React from 'react'
import { toast } from 'sonner'

import type { Workspace } from '@shared/workspace'
import type { Worktree, WorktreeStatusResult } from '@shared/worktree'
import { useTasks } from '@/contexts/tasks-context'
import {
  listWorkspaces,
  pickAndAddWorkspace,
  removeWorkspace as removeWorkspaceIpc
} from '@/lib/workspaces'
import { createBranch as createBranchIpc } from '@/lib/repo'
import {
  createWorktree as createWorktreeIpc,
  deleteWorktree as deleteWorktreeIpc,
  getWorktreeStatus as getWorktreeStatusIpc,
  listWorktreesForWorkspace
} from '@/lib/worktrees'

export interface UseWorkspacesResult {
  workspaces: Workspace[]
  worktreesByWorkspaceId: Record<string, Worktree[]>
  activeId: string | null
  deletingWorktreePaths: ReadonlySet<string>
  selectWorkspace: (id: string | null) => void
  addWorkspace: () => Promise<void>
  removeWorkspace: (id: string) => Promise<void>
  refreshWorktreesFor: (workspaceId: string) => Promise<void>
  createWorktree: (workspace: Workspace, name: string) => Promise<boolean>
  createBranchInWorktree: (
    workspace: Workspace,
    worktree: Worktree,
    fullBranchName: string
  ) => Promise<boolean>
  deleteWorktree: (workspace: Workspace, worktree: Worktree) => Promise<boolean>
  checkWorktreeStatus: (worktreePath: string) => Promise<WorktreeStatusResult>
}

export function useWorkspaces(): UseWorkspacesResult {
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [worktreesByWorkspaceId, setWorktreesByWorkspaceId] = React.useState<
    Record<string, Worktree[]>
  >({})
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [deletingWorktreePaths, setDeletingWorktreePaths] = React.useState<ReadonlySet<string>>(
    () => new Set<string>()
  )
  const { startTask, succeedTask, failTask } = useTasks()

  React.useEffect(() => {
    let cancelled = false
    listWorkspaces()
      .then((list) => {
        if (!cancelled) setWorkspaces(list)
      })
      .catch((err) => {
        console.error('[workspaces] failed to load list:', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    if (workspaces.length === 0) {
      return () => {
        cancelled = true
      }
    }

    Promise.allSettled(
      workspaces.map((ws) => listWorktreesForWorkspace(ws.path).then((wts) => ({ id: ws.id, wts })))
    ).then((results) => {
      if (cancelled) return
      const next: Record<string, Worktree[]> = {}
      results.forEach((r, idx) => {
        const ws = workspaces[idx]
        if (r.status === 'fulfilled') {
          next[r.value.id] = r.value.wts.filter((w) => !w.isMain)
        } else {
          next[ws.id] = []
        }
      })
      setWorktreesByWorkspaceId(next)
    })

    return () => {
      cancelled = true
    }
  }, [workspaces])

  const addWorkspace = React.useCallback(async (): Promise<void> => {
    const ws = await pickAndAddWorkspace()
    if (ws) {
      setWorkspaces((prev) => [...prev, ws])
      setActiveId(ws.id)
    }
  }, [])

  const removeWorkspace = React.useCallback(async (id: string): Promise<void> => {
    const next = await removeWorkspaceIpc(id)
    setWorkspaces(next)
    setWorktreesByWorkspaceId((prev) => {
      if (!(id in prev)) return prev
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    setActiveId((current) => (current === id ? null : current))
  }, [])

  const selectWorkspace = React.useCallback((id: string | null): void => {
    setActiveId(id)
  }, [])

  const refreshWorktreesFor = React.useCallback(
    async (workspaceId: string): Promise<void> => {
      const ws = workspaces.find((w) => w.id === workspaceId)
      if (!ws) return
      try {
        const list = await listWorktreesForWorkspace(ws.path)
        setWorktreesByWorkspaceId((prev) => ({
          ...prev,
          [workspaceId]: list.filter((w) => !w.isMain)
        }))
      } catch (err) {
        console.error('[worktrees] refresh failed:', err)
      }
    },
    [workspaces]
  )

  const createWorktree = React.useCallback(
    async (workspace: Workspace, name: string): Promise<boolean> => {
      const taskId = startTask(`Creating worktree "${name}" in ${workspace.name}`)
      try {
        const result = await createWorktreeIpc({
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          name
        })
        if (result.ok) {
          succeedTask(taskId)
          toast.success(`Worktree "${name}" created`)
          await refreshWorktreesFor(workspace.id)
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
      workspace: Workspace,
      worktree: Worktree,
      fullBranchName: string
    ): Promise<boolean> => {
      const label = worktreeLabel(worktree.path)
      const taskId = startTask(
        `Creating branch "${fullBranchName}" in ${workspace.name} / ${label}`
      )
      try {
        const result = await createBranchIpc({
          folderPath: worktree.path,
          name: fullBranchName
        })
        if (result.ok) {
          succeedTask(taskId)
          toast.success(`Branch "${result.branch}" created`)
          await refreshWorktreesFor(workspace.id)
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
    async (workspace: Workspace, worktree: Worktree): Promise<boolean> => {
      const label = worktreeLabel(worktree.path)
      setDeletingWorktreePaths((prev) => {
        const next = new Set(prev)
        next.add(worktree.path)
        return next
      })
      const taskId = startTask(`Deleting worktree "${label}" in ${workspace.name}`)
      try {
        const result = await deleteWorktreeIpc({
          workspacePath: workspace.path,
          worktreePath: worktree.path
        })
        if (result.ok) {
          succeedTask(taskId)
          toast.success(`Worktree "${label}" deleted`)
          await refreshWorktreesFor(workspace.id)
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
    workspaces,
    worktreesByWorkspaceId,
    activeId,
    deletingWorktreePaths,
    selectWorkspace,
    addWorkspace,
    removeWorkspace,
    refreshWorktreesFor,
    createWorktree,
    createBranchInWorktree,
    deleteWorktree,
    checkWorktreeStatus
  }
}
