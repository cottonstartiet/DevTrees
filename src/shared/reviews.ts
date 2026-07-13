import type { AdoErrorCode } from './ado'

/** Which remote host a pull request lives on. */
export type PrProvider = 'github' | 'ado'

/**
 * Relationship of the current user to a pull request, used to bucket the Reviews list.
 * - `mine`: the current user created the PR.
 * - `assigned`: the current user (or one of their teams) is a requested reviewer / assignee.
 * - `other`: everything else — open PRs that are candidates for review.
 */
export type PrCategory = 'mine' | 'assigned' | 'other'

/** Provider-agnostic pull request shape shared by the ADO and GitHub backends. */
export type RepoPr = {
  provider: PrProvider
  /** PR number (GitHub) or pull request id (Azure DevOps). */
  id: number
  title: string
  /** Author display name (ADO) or login (GitHub). */
  author: string
  /** Short source branch name (e.g. `feature/foo`). */
  sourceRef: string
  /** Short target branch name (e.g. `main`). */
  targetRef: string
  webUrl: string
  createdAt: string | null
  isDraft: boolean
  category: PrCategory
}

export type RepoOpenPrsRequest = { folderPath: string }

/** Error codes surfaced by the Reviews backends. Reuses ADO codes and adds GitHub (`gh`) ones. */
export type ReviewsErrorCode = AdoErrorCode | 'gh-not-installed' | 'gh-not-logged-in' | 'gh-failed'

export type RepoOpenPrsResult =
  | { ok: true; prs: RepoPr[] }
  | { ok: false; code: ReviewsErrorCode; message?: string }
