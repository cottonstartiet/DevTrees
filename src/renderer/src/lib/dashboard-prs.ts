import type { RepoPr } from '@shared/reviews'
import type { Worktree } from '@shared/worktree'

export function normalizePrBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export function findPrSourceWorktree(pr: RepoPr, worktrees: Worktree[]): Worktree | null {
  const sourceBranch = normalizePrBranch(pr.sourceRef)
  return (
    worktrees.find(
      (worktree) =>
        !worktree.isDetached &&
        worktree.branch !== null &&
        normalizePrBranch(worktree.branch) === sourceBranch
    ) ?? null
  )
}

export function newestPrFirst(left: RepoPr, right: RepoPr): number {
  return (right.createdAt ?? '').localeCompare(left.createdAt ?? '')
}
