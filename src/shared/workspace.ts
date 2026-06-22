export type WorkspaceRemoteKind = 'github' | 'ado' | 'other'

export type Workspace = {
  id: string
  path: string
  name: string
  addedAt: number
  remoteKind: WorkspaceRemoteKind
}

export type AddWorkspaceErrorCode = 'cancelled' | 'not-a-git-repo' | 'already-added' | 'unknown'

export type AddWorkspaceResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; error: AddWorkspaceErrorCode; message?: string }

export const WorkspaceIpcChannels = {
  PickAndAdd: 'workspaces:pick-and-add',
  List: 'workspaces:list',
  Remove: 'workspaces:remove'
} as const
