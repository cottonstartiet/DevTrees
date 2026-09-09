import type { TaskSourceProvider } from './task'

export type TaskImportItem = {
  provider: TaskSourceProvider
  id: string
  displayId: string
  title: string
  description: string
  state: string
  url: string
  updatedAt: string | null
}

export type TaskImportErrorCode =
  | 'git-failed'
  | 'no-origin'
  | 'unsupported-remote'
  | 'az-not-installed'
  | 'az-extension-missing'
  | 'az-not-logged-in'
  | 'az-failed'
  | 'gh-not-installed'
  | 'gh-not-logged-in'
  | 'gh-failed'
  | 'invalid-response'

export type TaskImportResult =
  | { ok: true; items: TaskImportItem[] }
  | { ok: false; code: TaskImportErrorCode; message?: string }
