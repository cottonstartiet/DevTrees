import { ipcMain } from 'electron'

import type {
  CreateWorktreeRequest,
  CreateWorktreeResult,
  DeleteWorktreeRequest,
  DeleteWorktreeResult,
  Worktree,
  WorktreeStatusResult
} from '../shared/worktree'
import { WorktreeIpcChannels } from '../shared/worktree'
import { createWorktree, deleteWorktree, getWorktreeChangeStatus, listWorktrees } from './worktrees'

export function registerWorktreeIpc(): void {
  ipcMain.handle(
    WorktreeIpcChannels.ListForWorkspace,
    async (_event, workspacePath: string): Promise<Worktree[]> => {
      try {
        return await listWorktrees(workspacePath)
      } catch (err) {
        console.error('[worktrees] list failed:', err)
        return []
      }
    }
  )

  ipcMain.handle(
    WorktreeIpcChannels.Create,
    async (_event, req: CreateWorktreeRequest): Promise<CreateWorktreeResult> => {
      try {
        return await createWorktree(req.workspacePath, req.name)
      } catch (err) {
        console.error('[worktrees] create failed:', err)
        return {
          ok: false,
          error: 'unknown',
          message: err instanceof Error ? err.message : 'Unknown error creating worktree.'
        }
      }
    }
  )

  ipcMain.handle(
    WorktreeIpcChannels.Delete,
    async (_event, req: DeleteWorktreeRequest): Promise<DeleteWorktreeResult> => {
      try {
        return await deleteWorktree(req.workspacePath, req.worktreePath)
      } catch (err) {
        console.error('[worktrees] delete failed:', err)
        return {
          ok: false,
          error: 'unknown',
          message: err instanceof Error ? err.message : 'Unknown error deleting worktree.'
        }
      }
    }
  )

  ipcMain.handle(
    WorktreeIpcChannels.Status,
    async (_event, worktreePath: string): Promise<WorktreeStatusResult> => {
      try {
        return await getWorktreeChangeStatus(worktreePath)
      } catch (err) {
        console.error('[worktrees] status failed:', err)
        return {
          ok: false,
          error: 'unknown',
          message: err instanceof Error ? err.message : 'Unknown error checking worktree status.'
        }
      }
    }
  )
}
