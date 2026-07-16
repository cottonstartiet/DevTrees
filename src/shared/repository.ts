export type RepositoryRemoteKind = 'github' | 'ado' | 'other'

export type Repository = {
  id: string
  path: string
  name: string
  addedAt: number
  remoteKind: RepositoryRemoteKind
}

export type AddRepositoryErrorCode = 'cancelled' | 'not-a-git-repo' | 'already-added' | 'unknown'

export type AddRepositoryResult =
  | { ok: true; repository: Repository }
  | { ok: false; error: AddRepositoryErrorCode; message?: string }

export const RepositoryIpcChannels = {
  PickAndAdd: 'repositories:pick-and-add',
  List: 'repositories:list',
  Remove: 'repositories:remove',
  Reorder: 'repositories:reorder'
} as const
