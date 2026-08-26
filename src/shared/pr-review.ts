import type { PrProvider, RepoPrThread, ReviewsErrorCode } from './reviews'

/**
 * Provider-agnostic contract for the in-app pull-request review workspace.
 *
 * Every shape here is produced by both the Azure DevOps (`ado.rs`) and GitHub (`github.rs`)
 * backends so the review UI never branches on provider. Diffs always come from the provider API:
 * GitHub returns a unified patch per file, Azure DevOps returns base/head blobs that the backend
 * diffs itself — both are normalised into {@link PrFileDiff}.
 */

/** The current user's vote on a PR, using Azure DevOps' richer vocabulary as the superset. */
export type PrVote =
  | 'none'
  | 'approved'
  | 'approvedWithSuggestions'
  | 'waitingForAuthor'
  | 'rejected'

/** Lifecycle state of the pull request itself. */
export type PrState = 'open' | 'merged' | 'abandoned' | 'unknown'

/** Header-level detail for the review workspace. */
export type PrReviewDetail = {
  provider: PrProvider
  id: number
  title: string
  description: string
  author: string
  sourceRef: string
  targetRef: string
  /** Tip commit of the source branch — required to anchor GitHub review comments. */
  headSha: string
  /** Merge-base / target commit the diff is computed against. */
  baseSha: string
  webUrl: string
  isDraft: boolean
  state: PrState
  myVote: PrVote
}

export type PrChangeType = 'add' | 'edit' | 'delete' | 'rename'

/** One entry in the changed-files sidebar. */
export type PrChangedFile = {
  /** Repository-relative path with forward slashes and no leading slash. */
  path: string
  /** Original path when `changeType` is `rename`. */
  previousPath?: string
  changeType: PrChangeType
  additions: number
  deletions: number
  isBinary: boolean
  /** True for `.md` / `.markdown` files, which get the Diff | Preview | Raw toggle. */
  isMarkdown: boolean
}

export type PrDiffLineKind = 'context' | 'add' | 'del'

export type PrDiffLine = {
  kind: PrDiffLineKind
  /** 1-based line number on the base (left) side, or null for added lines. */
  baseLine: number | null
  /** 1-based line number on the head (right) side, or null for deleted lines. */
  headLine: number | null
  /** Line text without the leading +/-/space marker and without a trailing newline. */
  text: string
}

export type PrDiffHunk = {
  /** The `@@ -a,b +c,d @@` header line. */
  header: string
  baseStart: number
  baseLines: number
  headStart: number
  headLines: number
  lines: PrDiffLine[]
}

export type PrFileDiff = {
  path: string
  hunks: PrDiffHunk[]
  isBinary: boolean
  /** True when the provider or a size guard truncated the diff. */
  truncated: boolean
}

export type PrFileSide = 'base' | 'head'

/** Full text of one side of a file, used by the markdown preview and raw views. */
export type PrFileContent = {
  path: string
  side: PrFileSide
  text: string
  isBinary: boolean
  truncated: boolean
}

/** Where a new comment thread is pinned. */
export type PrCommentAnchor = {
  filePath: string
  /** `right` = head side (the only side the workspace comments on today). */
  side: 'right' | 'left'
  /** 1-based inclusive start line in the file on `side`. */
  startLine: number
  /** 1-based inclusive end line; equals `startLine` for single-line comments. */
  endLine: number
  /** Whether the anchor came from the diff gutter or a rendered markdown block. */
  origin: 'diff' | 'preview'
}

export type PrReviewDetailRequest = { folderPath: string; pullRequestId: number }

export type PrChangedFilesRequest = { folderPath: string; pullRequestId: number }

export type PrFileDiffRequest = {
  folderPath: string
  pullRequestId: number
  path: string
}

export type PrFileContentRequest = {
  folderPath: string
  pullRequestId: number
  path: string
  side: PrFileSide
}

export type PrCreateThreadRequest = {
  folderPath: string
  pullRequestId: number
  anchor: PrCommentAnchor | null
  /** Markdown body of the first comment. */
  content: string
}

export type PrReplyRequest = {
  folderPath: string
  pullRequestId: number
  /** Provider thread handle from `RepoPrThread.providerThreadId`. */
  threadId: string
  /** GitHub addresses replies by the thread's root comment id (`RepoPrThread.id`). */
  rootCommentId?: number
  content: string
}

export type PrSetThreadStatusRequest = {
  folderPath: string
  pullRequestId: number
  threadId: string
  resolved: boolean
}

export type PrSetVoteRequest = {
  folderPath: string
  pullRequestId: number
  vote: PrVote
  /** Optional review body posted alongside the vote (GitHub review comment). */
  content?: string
}

type Fail = { ok: false; code: ReviewsErrorCode; message?: string }

export type PrReviewDetailResult = { ok: true; detail: PrReviewDetail } | Fail
export type PrChangedFilesResult = { ok: true; files: PrChangedFile[] } | Fail
export type PrFileDiffResult = { ok: true; diff: PrFileDiff } | Fail
export type PrFileContentResult = { ok: true; content: PrFileContent } | Fail
/**
 * Result of a write. `thread` is the created/updated thread when the provider returns it, so the
 * UI can render the new comment without a full refetch.
 */
export type PrMutationResult = { ok: true; thread?: RepoPrThread } | Fail

/** Markdown file extensions that get the preview/raw toggle. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}
