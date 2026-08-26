import type {
  PrChangedFilesRequest,
  PrChangedFilesResult,
  PrCreateThreadRequest,
  PrFileContentRequest,
  PrFileContentResult,
  PrFileDiffRequest,
  PrFileDiffResult,
  PrMutationResult,
  PrReplyRequest,
  PrReviewDetailRequest,
  PrReviewDetailResult,
  PrSetThreadStatusRequest,
  PrSetVoteRequest
} from '@shared/pr-review'
import type { RepositoryRemoteKind } from '@shared/repository'

/** Remotes the in-app review workspace can talk to. */
export type ReviewRemoteKind = 'ado' | 'github'

export function isReviewableRemote(
  remoteKind: RepositoryRemoteKind | null
): remoteKind is ReviewRemoteKind {
  return remoteKind === 'ado' || remoteKind === 'github'
}

/**
 * Route a PR-review call to the provider matching the repository's remote.
 *
 * Every operation exposes an `ado` and a `github` implementation with identical signatures, so
 * dispatch is a single lookup and callers stay provider-blind.
 */
function route<Req, Res>(
  remoteKind: ReviewRemoteKind,
  pair: { ado: (req: Req) => Promise<Res>; github: (req: Req) => Promise<Res> },
  req: Req
): Promise<Res> {
  return pair[remoteKind](req)
}

export function getPrDetail(
  remoteKind: ReviewRemoteKind,
  req: PrReviewDetailRequest
): Promise<PrReviewDetailResult> {
  return route(remoteKind, window.api.prReview.detail, req)
}

export function getPrChangedFiles(
  remoteKind: ReviewRemoteKind,
  req: PrChangedFilesRequest
): Promise<PrChangedFilesResult> {
  return route(remoteKind, window.api.prReview.changedFiles, req)
}

export function getPrFileDiff(
  remoteKind: ReviewRemoteKind,
  req: PrFileDiffRequest
): Promise<PrFileDiffResult> {
  return route(remoteKind, window.api.prReview.fileDiff, req)
}

export function getPrFileContent(
  remoteKind: ReviewRemoteKind,
  req: PrFileContentRequest
): Promise<PrFileContentResult> {
  return route(remoteKind, window.api.prReview.fileContent, req)
}

export function createPrThread(
  remoteKind: ReviewRemoteKind,
  req: PrCreateThreadRequest
): Promise<PrMutationResult> {
  return route(remoteKind, window.api.prReview.createThread, req)
}

export function replyToPrThread(
  remoteKind: ReviewRemoteKind,
  req: PrReplyRequest
): Promise<PrMutationResult> {
  return route(remoteKind, window.api.prReview.reply, req)
}

export function setPrThreadStatus(
  remoteKind: ReviewRemoteKind,
  req: PrSetThreadStatusRequest
): Promise<PrMutationResult> {
  return route(remoteKind, window.api.prReview.setThreadStatus, req)
}

export function setPrVote(
  remoteKind: ReviewRemoteKind,
  req: PrSetVoteRequest
): Promise<PrMutationResult> {
  return route(remoteKind, window.api.prReview.setVote, req)
}
