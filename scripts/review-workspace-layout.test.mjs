import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const workspace = readFileSync(
  resolve('src', 'renderer', 'src', 'components', 'pr-review', 'review-workspace.tsx'),
  'utf8'
)

test('review workspace fills its native window without behaving like a modal', () => {
  assert.match(workspace, /bg-background flex h-full min-h-0 w-full flex-col/)
  assert.doesNotMatch(workspace, /fixed inset-0/)
  assert.doesNotMatch(workspace, /event\.key === ['"]Escape['"]/)
  assert.match(workspace, /event\.key === ['"]j['"]/)
  assert.match(workspace, /event\.key === ['"]k['"]/)
  assert.match(workspace, /event\.key === ['"]p['"]/)
})
