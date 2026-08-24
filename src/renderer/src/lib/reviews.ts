import type {
  RepoOpenPrsRequest,
  RepoOpenPrsResult,
  RepoPrThreadsRequest,
  RepoPrThreadsResult
} from '@shared/reviews'
import type { RepositoryRemoteKind } from '@shared/repository'

/** Route an open-PRs request to the provider matching the repository's remote, when supported. */
export function getRepoOpenPrs(
  remoteKind: RepositoryRemoteKind,
  req: RepoOpenPrsRequest
): Promise<RepoOpenPrsResult> | null {
  if (remoteKind === 'ado') return window.api.reviews.openPrs.ado(req)
  if (remoteKind === 'github') return window.api.reviews.openPrs.github(req)
  return null
}

/** Route a PR-threads request to the provider matching the repository's remote, when supported. */
export function getPrThreads(
  remoteKind: RepositoryRemoteKind,
  req: RepoPrThreadsRequest
): Promise<RepoPrThreadsResult> | null {
  if (remoteKind === 'ado') return window.api.reviews.prThreads.ado(req)
  if (remoteKind === 'github') return window.api.reviews.prThreads.github(req)
  return null
}
