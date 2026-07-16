import { toast } from 'sonner'

import type { AddRepositoryErrorCode, AddRepositoryResult, Repository } from '@shared/repository'

const errorMessages: Record<AddRepositoryErrorCode, string> = {
  cancelled: '',
  'not-a-git-repo': 'Selected folder is not a git repository.',
  'already-added': 'This repository is already added.',
  unknown: 'Could not add repository.'
}

export async function pickAndAddRepository(): Promise<Repository | null> {
  const result: AddRepositoryResult = await window.api.repositories.pickAndAdd()
  if (result.ok) {
    toast.success(`Added repository "${result.repository.name}"`)
    return result.repository
  }
  if (result.error === 'cancelled') return null
  const message = result.message ?? errorMessages[result.error]
  toast.error(message)
  return null
}

export function listRepositories(): Promise<Repository[]> {
  return window.api.repositories.list()
}

export function removeRepository(id: string): Promise<Repository[]> {
  return window.api.repositories.remove(id)
}

export function reorderRepositories(orderedIds: string[]): Promise<Repository[]> {
  return window.api.repositories.reorder(orderedIds)
}
