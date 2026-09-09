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
  /** PR description/body, used by Reviews search. */
  description: string
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

export type AutoReviewClaimRequest = {
  repositoryPath: string
  provider: PrProvider
  pullRequestId: number
}

export type AutoReviewClaimResult = {
  claimed: boolean
}

export type RepoPrThreadStatus =
  | 'unknown'
  | 'active'
  | 'pending'
  | 'fixed'
  | 'wontFix'
  | 'closed'
  | 'byDesign'

export type RepoPrCommentAuthor = {
  displayName: string
  uniqueName?: string
}

export type RepoPrComment = {
  id: number
  author: RepoPrCommentAuthor
  content: string
  publishedDate: string | null
}

/** Provider-agnostic PR review-comment thread shared by the ADO and GitHub backends. */
export type RepoPrThread = {
  id: number
  /**
   * Provider handle used for writes (replies, resolve/unresolve): the GraphQL node id on GitHub,
   * the numeric thread id as a string on Azure DevOps.
   */
  providerThreadId: string
  status: RepoPrThreadStatus
  filePath: string | null
  lineNumber: number | null
  /** Last line of the thread's anchor range; equals `lineNumber` for single-line threads. */
  endLineNumber: number | null
  isResolved: boolean
  comments: RepoPrComment[]
  lastUpdated: string | null
  webUrl: string
}

export type RepoPrThreadsRequest = {
  folderPath: string
  pullRequestId: number
  /** Include resolved/closed threads. Defaults to false (only threads needing attention). */
  includeResolved?: boolean
}

export type RepoPrThreadsResult =
  | { ok: true; threads: RepoPrThread[] }
  | { ok: false; code: ReviewsErrorCode; message?: string }
