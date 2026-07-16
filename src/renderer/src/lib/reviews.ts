import type { RepoOpenPrsRequest, RepoOpenPrsResult } from '@shared/reviews'
import type { RepositoryRemoteKind } from '@shared/repository'

export function getAdoRepoOpenPrs(req: RepoOpenPrsRequest): Promise<RepoOpenPrsResult> {
  return window.api.ado.repoOpenPrs(req)
}

export function getGithubRepoOpenPrs(req: RepoOpenPrsRequest): Promise<RepoOpenPrsResult> {
  return window.api.github.repoOpenPrs(req)
}

/** Route an open-PRs request to the provider matching the repository's remote, when supported. */
export function getRepoOpenPrs(
  remoteKind: RepositoryRemoteKind,
  req: RepoOpenPrsRequest
): Promise<RepoOpenPrsResult> | null {
  if (remoteKind === 'ado') return getAdoRepoOpenPrs(req)
  if (remoteKind === 'github') return getGithubRepoOpenPrs(req)
  return null
}
