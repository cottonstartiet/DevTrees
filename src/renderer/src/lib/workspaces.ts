import { toast } from 'sonner'

import type { AddWorkspaceErrorCode, AddWorkspaceResult, Workspace } from '@shared/workspace'

const errorMessages: Record<AddWorkspaceErrorCode, string> = {
  cancelled: '',
  'not-a-git-repo': 'Selected folder is not a git repository.',
  'already-added': 'This workspace is already added.',
  unknown: 'Could not add workspace.'
}

export async function pickAndAddWorkspace(): Promise<Workspace | null> {
  const result: AddWorkspaceResult = await window.api.workspaces.pickAndAdd()
  if (result.ok) {
    toast.success(`Added workspace "${result.workspace.name}"`)
    return result.workspace
  }
  if (result.error === 'cancelled') return null
  const message = result.message ?? errorMessages[result.error]
  toast.error(message)
  return null
}

export function listWorkspaces(): Promise<Workspace[]> {
  return window.api.workspaces.list()
}

export function removeWorkspace(id: string): Promise<Workspace[]> {
  return window.api.workspaces.remove(id)
}
