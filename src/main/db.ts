import { app } from 'electron'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import Database from 'better-sqlite3'

import type { Workspace } from '../shared/workspace'

type Db = Database.Database

const DB_FILE = 'devtrees.db'
const LEGACY_JSON_FILE = 'workspaces.json'

let dbInstance: Db | null = null

function dbPath(): string {
  return join(app.getPath('userData'), DB_FILE)
}

const migrations: ReadonlyArray<(db: Db) => void> = [
  // Migration 0001 -> user_version becomes 1
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id        TEXT PRIMARY KEY,
        path      TEXT NOT NULL,
        name      TEXT NOT NULL,
        added_at  INTEGER NOT NULL,
        path_key  TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_workspaces_added_at ON workspaces(added_at);
    `)
  },
  // Migration 0002 -> user_version becomes 2 (pinned worktree notes)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS worktree_notes (
        path_key   TEXT PRIMARY KEY,
        path       TEXT NOT NULL,
        note       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  },
  // Migration 0003 -> user_version becomes 3 (notes feature removed; drop the now-orphaned table)
  (db) => {
    db.exec(`DROP TABLE IF EXISTS worktree_notes;`)
  }
]

function runMigrations(db: Db): void {
  const row = db.pragma('user_version', { simple: true }) as number
  const version = typeof row === 'number' ? row : 0
  for (let i = version; i < migrations.length; i++) {
    const apply = migrations[i]
    db.transaction(() => {
      apply(db)
      db.pragma(`user_version = ${i + 1}`)
    })()
  }
}

function importLegacyJsonIfPresent(db: Db): void {
  const userData = app.getPath('userData')
  const jsonFile = join(userData, LEGACY_JSON_FILE)
  if (!existsSync(jsonFile)) return

  const countRow = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }
  if (countRow.n > 0) return

  try {
    const raw = readFileSync(jsonFile, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return
    const insert = db.prepare(
      'INSERT OR IGNORE INTO workspaces (id, path, name, added_at, path_key) VALUES (@id, @path, @name, @addedAt, @pathKey)'
    )
    const importMany = db.transaction((rows: Workspace[]) => {
      for (const w of rows) {
        insert.run({
          id: w.id,
          path: w.path,
          name: w.name,
          addedAt: w.addedAt,
          pathKey: process.platform === 'win32' ? w.path.toLowerCase() : w.path
        })
      }
    })
    const valid = parsed.filter(
      (w): w is Workspace =>
        !!w &&
        typeof w === 'object' &&
        typeof (w as Workspace).id === 'string' &&
        typeof (w as Workspace).path === 'string' &&
        typeof (w as Workspace).name === 'string' &&
        typeof (w as Workspace).addedAt === 'number'
    )
    importMany(valid)
    try {
      renameSync(jsonFile, `${jsonFile}.migrated`)
    } catch (err) {
      console.warn('[db] could not rename legacy workspaces.json:', err)
    }
  } catch (err) {
    console.warn('[db] legacy workspaces.json import failed:', err)
  }
}

export function getDb(): Db {
  if (dbInstance) return dbInstance
  const db = new Database(dbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  importLegacyJsonIfPresent(db)
  dbInstance = db
  return db
}

export function closeDb(): void {
  if (!dbInstance) return
  try {
    dbInstance.close()
  } catch (err) {
    console.warn('[db] close failed:', err)
  }
  dbInstance = null
}
