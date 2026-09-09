import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(resolve('src', 'shared', 'task.ts'), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const compiled = { exports: {} }
new Function('module', 'exports', outputText)(compiled, compiled.exports)
const { selectTaskQueueCandidates, taskLaunchInitialMode } = compiled.exports

test('a new task triggered into in progress starts in plan mode', () => {
  assert.equal(taskLaunchInitialMode('todo'), 'plan')
})

test('a review task starts in autopilot mode', () => {
  assert.equal(taskLaunchInitialMode('review'), 'autopilot')
})

test('existing non-review task stages do not force an initial mode', () => {
  for (const status of ['in_progress', 'done']) {
    assert.equal(taskLaunchInitialMode(status), undefined)
  }
})

test('queue selection takes one FIFO head per free execution target', () => {
  const queued = [
    { id: 'a1', executionTargetKey: 'a' },
    { id: 'a2', executionTargetKey: 'a' },
    { id: 'b1', executionTargetKey: 'b' },
    { id: 'c1', executionTargetKey: 'c' }
  ]
  assert.deepEqual(
    selectTaskQueueCandidates(queued, [], [], 3).map((task) => task.id),
    ['a1', 'b1', 'c1']
  )
})

test('queue selection skips running and dispatching targets without head-of-line blocking', () => {
  const queued = [
    { id: 'a1', executionTargetKey: 'a' },
    { id: 'b1', executionTargetKey: 'b' },
    { id: 'c1', executionTargetKey: 'c' }
  ]
  assert.deepEqual(
    selectTaskQueueCandidates(queued, [{ executionTargetKey: 'a' }], new Set(['b']), 2).map(
      (task) => task.id
    ),
    ['c1']
  )
})
