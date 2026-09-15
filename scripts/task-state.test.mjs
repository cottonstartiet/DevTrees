import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import ts from 'typescript'

const { outputText } = ts.transpileModule(
  readFileSync(new URL('../src/renderer/src/lib/task-state.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
)
const compiled = { exports: {} }
new Function('module', 'exports', outputText)(compiled, compiled.exports)
const { reconcileTaskList, moveTaskOptimistically } = compiled.exports
const task = (id, extra = {}) => ({ id, status: 'todo', sortOrder: 0, updatedAt: 0, ...extra })

test('old lists cannot overwrite concurrent creates, edits, queue links or deletions', () => {
  const a = task('a', { copilotSessionId: 'new-session', queueStatus: 'running' })
  const b = task('b')
  const current = [a, b]
  const result = reconcileTaskList(
    current,
    [task('a'), task('deleted')],
    new Set(['a', 'b', 'deleted'])
  )
  assert.deepEqual(result, current)
  assert.deepEqual(reconcileTaskList([], [task('deleted')], new Set(['deleted'])), [])
  assert.deepEqual(reconcileTaskList(current, [task('a')], new Set()), [task('a')])
})

test('concurrent edits merge by field rather than dropping a successful mutation', () => {
  const original = task('a', { title: 'Before', copilotSessionId: null })
  const local = { ...original, copilotSessionId: 'session', updatedAt: 1 }
  const response = { ...original, title: 'After', status: 'in_progress', updatedAt: 2 }
  assert.deepEqual(reconcileTaskList([local], [response], new Set(['a']), true, [original]), [
    { ...response, copilotSessionId: 'session' }
  ])
})

test('single-row responses preserve unrelated tasks and do not duplicate creates', () => {
  const b = task('b')
  assert.deepEqual(reconcileTaskList([task('a'), b], [b], new Set(), false), [task('a'), b])
})

test('optimistic moves compose, preserve fields, and assign actual visible sort order', () => {
  const original = [task('a'), task('b', { sortOrder: 1 }), task('c', { status: 'done' })]
  const first = moveTaskOptimistically(original, 'b', 'todo', 'a')
  assert.deepEqual(
    first.filter((t) => t.status === 'todo').map((t) => [t.id, t.sortOrder]),
    [
      ['b', 0],
      ['a', 1]
    ]
  )
  const second = moveTaskOptimistically(first, 'a', 'done', 'c')
  assert.deepEqual(
    second.filter((t) => t.status === 'done').map((t) => t.id),
    ['a', 'c']
  )
  assert.equal(original[1].sortOrder, 1)
  assert.equal(moveTaskOptimistically(original, 'missing', 'done'), original)
})
