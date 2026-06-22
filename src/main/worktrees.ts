import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import type {
  CreateWorktreeResult,
  DeleteWorktreeResult,
  Worktree,
  WorktreeStatusResult
} from '../shared/worktree'
import { GitError, runGit } from './git'

const VALID_NAME = /^[A-Za-z0-9._-]+$/
const MAX_NAME_LENGTH = 64

function normalize(p: string): string {
  return resolve(p)
}

function pathsEqual(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  if (process.platform === 'win32') {
    return na.toLowerCase() === nb.toLowerCase()
  }
  return na === nb
}

function parseWorktreePorcelain(stdout: string, workspacePath: string): Worktree[] {
  const records = stdout.split(/\r?\n\r?\n/)
  const out: Worktree[] = []
  for (const raw of records) {
    const block = raw.trim()
    if (!block) continue
    const lines = block.split(/\r?\n/)
    let path: string | null = null
    let head = ''
    let branch: string | null = null
    let isDetached = false
    let isLocked = false
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length).trim()
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim()
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim()
        branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      } else if (line === 'detached') {
        isDetached = true
      } else if (line === 'locked' || line.startsWith('locked ')) {
        isLocked = true
      }
    }
    if (!path) continue
    const canonical = normalize(path)
    out.push({
      path: canonical,
      branch,
      head,
      isDetached,
      isMain: pathsEqual(canonical, workspacePath),
      isLocked
    })
  }
  return out
}

export async function listWorktrees(workspacePath: string): Promise<Worktree[]> {
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], workspacePath)
  return parseWorktreePorcelain(stdout, workspacePath)
}

export function computeWorktreeDestination(workspacePath: string, name: string): string {
  const ws = normalize(workspacePath)
  const parent = dirname(ws)
  const wsName = basename(ws)
  return resolve(parent, `${wsName}.worktrees`, name)
}

export async function createWorktree(
  workspacePath: string,
  name: string
): Promise<CreateWorktreeResult> {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH || !VALID_NAME.test(trimmed)) {
    return { ok: false, error: 'invalid-name' }
  }

  const dest = computeWorktreeDestination(workspacePath, trimmed)
  if (existsSync(dest)) {
    return { ok: false, error: 'already-exists', message: `Destination already exists: ${dest}` }
  }

  try {
    await mkdir(dirname(dest), { recursive: true })
  } catch (err) {
    return {
      ok: false,
      error: 'unknown',
      message: err instanceof Error ? err.message : 'Failed to prepare destination folder.'
    }
  }

  try {
    await runGit(['worktree', 'add', '--detach', dest], workspacePath)
  } catch (err) {
    if (err instanceof GitError) {
      return { ok: false, error: 'git-failed', message: err.message }
    }
    return {
      ok: false,
      error: 'unknown',
      message: err instanceof Error ? err.message : 'Unknown git failure.'
    }
  }

  const all = await listWorktrees(workspacePath)
  const created = all.find((w) => pathsEqual(w.path, dest))
  if (!created) {
    return {
      ok: false,
      error: 'unknown',
      message: 'Worktree created but could not be located afterwards.'
    }
  }

  return { ok: true, worktree: created }
}

export async function getWorktreeChangeStatus(worktreePath: string): Promise<WorktreeStatusResult> {
  if (!existsSync(worktreePath)) {
    return { ok: true, hasChanges: false, hasUnreachableCommits: false, folderMissing: true }
  }

  let porcelain: string
  try {
    const { stdout } = await runGit(
      ['status', '--porcelain=v1', '--untracked-files=all'],
      worktreePath
    )
    porcelain = stdout
  } catch (err) {
    if (err instanceof GitError) {
      return { ok: false, error: 'git-failed', message: err.message }
    }
    return {
      ok: false,
      error: 'unknown',
      message: err instanceof Error ? err.message : 'git status failed'
    }
  }
  const hasChanges = porcelain.split(/\r?\n/).some((l) => l.trim().length > 0)

  let hasUnreachableCommits = false
  let head = ''
  try {
    const { stdout } = await runGit(['rev-parse', 'HEAD'], worktreePath)
    head = stdout.trim()
  } catch (err) {
    if (err instanceof GitError) {
      return { ok: false, error: 'git-failed', message: err.message }
    }
    return {
      ok: false,
      error: 'unknown',
      message: err instanceof Error ? err.message : 'git rev-parse failed'
    }
  }

  let symbolic: string | null = null
  try {
    const { stdout } = await runGit(['symbolic-ref', '--quiet', 'HEAD'], worktreePath)
    symbolic = stdout.trim() || null
  } catch {
    symbolic = null
  }
  const isDetached = symbolic === null

  if (isDetached && head) {
    try {
      const { stdout } = await runGit(
        ['for-each-ref', '--contains', head, '--count=1', '--format=%(refname)'],
        worktreePath
      )
      hasUnreachableCommits = stdout.trim().length === 0
    } catch {
      hasUnreachableCommits = false
    }
  }

  return { ok: true, hasChanges, hasUnreachableCommits }
}

export async function deleteWorktree(
  workspacePath: string,
  worktreePath: string
): Promise<DeleteWorktreeResult> {
  if (pathsEqual(worktreePath, workspacePath)) {
    return {
      ok: false,
      error: 'is-main',
      message: 'Cannot delete the main worktree of a workspace.'
    }
  }

  const all = await listWorktrees(workspacePath).catch(() => [] as Worktree[])
  const found = all.find((w) => pathsEqual(w.path, worktreePath))
  if (!found) {
    return {
      ok: false,
      error: 'not-found',
      message: `Worktree not registered with this workspace: ${worktreePath}`
    }
  }
  if (found.isLocked) {
    return {
      ok: false,
      error: 'is-locked',
      message: 'Worktree is locked. Unlock it with `git worktree unlock` before deleting.'
    }
  }

  if (existsSync(worktreePath)) {
    const status = await getWorktreeChangeStatus(worktreePath)
    if (!status.ok) {
      return { ok: false, error: 'git-failed', message: status.message }
    }
    if (status.hasChanges) {
      return {
        ok: false,
        error: 'has-changes',
        message: 'Worktree has uncommitted changes. Commit them before deleting.'
      }
    }
    if (status.hasUnreachableCommits) {
      return {
        ok: false,
        error: 'unreachable-commits',
        message:
          "Worktree's detached HEAD has commits not reachable from any branch. " +
          'Create a branch for them before deleting.'
      }
    }
  } else {
    try {
      await runGit(['worktree', 'prune'], workspacePath)
    } catch (err) {
      if (err instanceof GitError) {
        return { ok: false, error: 'git-failed', message: err.message }
      }
      return {
        ok: false,
        error: 'unknown',
        message: err instanceof Error ? err.message : 'git worktree prune failed.'
      }
    }
    const remaining = await listWorktrees(workspacePath).catch(() => [] as Worktree[])
    if (remaining.some((w) => pathsEqual(w.path, worktreePath))) {
      return {
        ok: false,
        error: 'git-failed',
        message: `git worktree prune did not remove the stale entry for ${worktreePath}.`
      }
    }
    return { ok: true }
  }

  try {
    await runGit(['worktree', 'remove', worktreePath], workspacePath)
    return { ok: true }
  } catch (err) {
    if (err instanceof GitError) {
      if (/contains modified or untracked files/i.test(err.message)) {
        return { ok: false, error: 'has-changes', message: err.message }
      }
      if (/is locked/i.test(err.message)) {
        return { ok: false, error: 'is-locked', message: err.message }
      }
      return { ok: false, error: 'git-failed', message: err.message }
    }
    return {
      ok: false,
      error: 'unknown',
      message: err instanceof Error ? err.message : 'Unknown git failure.'
    }
  }
}
