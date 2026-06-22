import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import type { AddWorkspaceResult, Workspace, WorkspaceRemoteKind } from '../shared/workspace'
import { getDb } from './db'
import { runGit } from './git'

type WorkspaceRow = {
  id: string
  path: string
  name: string
  added_at: number
}

function rowToBaseWorkspace(row: WorkspaceRow): Omit<Workspace, 'remoteKind'> {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    addedAt: row.added_at
  }
}

function pathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function isGitRepo(folder: string): boolean {
  // .git can be a directory (regular clone) or a file (submodule, worktree gitlink)
  return existsSync(join(folder, '.git'))
}

export function classifyRemoteUrl(url: string | null | undefined): WorkspaceRemoteKind {
  if (!url) return 'other'
  const trimmed = url.trim()
  if (!trimmed) return 'other'

  // GitHub: https://github.com/..., http(s)://...@github.com/..., git@github.com:owner/repo, ssh://git@github.com/...
  if (/^(https?|ssh):\/\/(?:[^@/]+@)?github\.com[/:]/i.test(trimmed)) return 'github'
  if (/^[^@\s]+@github\.com:/i.test(trimmed)) return 'github'

  // Azure DevOps:
  //   https://dev.azure.com/...
  //   https://{org}.visualstudio.com/...
  //   ssh://git@ssh.dev.azure.com/...   or   git@ssh.dev.azure.com:v3/...
  //   git@{org}.vs-ssh.visualstudio.com:v3/...
  if (/^(https?|ssh):\/\/(?:[^@/]+@)?dev\.azure\.com[/:]/i.test(trimmed)) return 'ado'
  if (/^(https?|ssh):\/\/(?:[^@/]+@)?ssh\.dev\.azure\.com[/:]/i.test(trimmed)) return 'ado'
  if (/^(https?|ssh):\/\/(?:[^@/]+@)?[^./@\s]+\.visualstudio\.com[/:]/i.test(trimmed)) return 'ado'
  if (/^(https?|ssh):\/\/(?:[^@/]+@)?[^./@\s]+\.vs-ssh\.visualstudio\.com[/:]/i.test(trimmed))
    return 'ado'
  if (/^[^@\s]+@ssh\.dev\.azure\.com:/i.test(trimmed)) return 'ado'
  if (/^[^@\s]+@[^./@\s]+\.vs-ssh\.visualstudio\.com:/i.test(trimmed)) return 'ado'

  return 'other'
}

async function detectRemoteKind(folderPath: string): Promise<WorkspaceRemoteKind> {
  try {
    const { stdout } = await runGit(['remote', 'get-url', 'origin'], folderPath)
    return classifyRemoteUrl(stdout.trim())
  } catch {
    return 'other'
  }
}

async function enrichWorkspace(base: Omit<Workspace, 'remoteKind'>): Promise<Workspace> {
  return { ...base, remoteKind: await detectRemoteKind(base.path) }
}

export async function loadWorkspaces(): Promise<Workspace[]> {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, path, name, added_at FROM workspaces ORDER BY added_at ASC')
    .all() as WorkspaceRow[]
  const bases = rows.map(rowToBaseWorkspace)
  return Promise.all(bases.map(enrichWorkspace))
}

export async function addWorkspace(folder: string): Promise<AddWorkspaceResult> {
  const resolved = resolve(folder)

  if (!existsSync(resolved)) {
    return { ok: false, error: 'unknown', message: 'Folder does not exist.' }
  }

  if (!isGitRepo(resolved)) {
    return { ok: false, error: 'not-a-git-repo' }
  }

  const base: Omit<Workspace, 'remoteKind'> = {
    id: randomUUID(),
    path: resolved,
    name: basename(resolved),
    addedAt: Date.now()
  }

  const db = getDb()
  try {
    db.prepare(
      'INSERT INTO workspaces (id, path, name, added_at, path_key) VALUES (@id, @path, @name, @addedAt, @pathKey)'
    ).run({
      id: base.id,
      path: base.path,
      name: base.name,
      addedAt: base.addedAt,
      pathKey: pathKey(resolved)
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return { ok: false, error: 'already-added' }
    }
    console.error('[workspaces] insert failed:', err)
    return { ok: false, error: 'unknown', message: (err as Error).message }
  }

  const workspace = await enrichWorkspace(base)
  return { ok: true, workspace }
}

export async function removeWorkspace(id: string): Promise<Workspace[]> {
  const db = getDb()
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  return loadWorkspaces()
}
