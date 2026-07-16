import type {
  CreateWorktreeRequest,
  CreateWorktreeResult,
  DeleteWorktreeRequest,
  DeleteWorktreeResult,
  Worktree,
  WorktreeStatusResult
} from '@shared/worktree'

export function listWorktreesForRepository(repositoryPath: string): Promise<Worktree[]> {
  return window.api.worktrees.listForRepository(repositoryPath)
}

export function createWorktree(req: CreateWorktreeRequest): Promise<CreateWorktreeResult> {
  return window.api.worktrees.create(req)
}

export function deleteWorktree(req: DeleteWorktreeRequest): Promise<DeleteWorktreeResult> {
  return window.api.worktrees.delete(req)
}

export function getWorktreeStatus(worktreePath: string): Promise<WorktreeStatusResult> {
  return window.api.worktrees.status(worktreePath)
}
