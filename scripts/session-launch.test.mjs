import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

function load(relativePath) {
  const source = readFileSync(resolve(...relativePath), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const compiled = { exports: {} }
  new Function('module', 'exports', outputText)(compiled, compiled.exports)
  return compiled.exports
}

const { isExternalSessionEnded, missingExternalSessions, terminalObservationIssue } = load([
  'src',
  'shared',
  'terminal-session.ts'
])
const { sessionLaunchModeLabel } = load(['src', 'shared', 'settings.ts'])
const session = (transport, status = 'working') => ({
  id: 'session',
  transport,
  status,
  revision: 10,
  observedAt: 1000
})

test('only finished external sessions disappear; idle is still running', () => {
  for (const status of ['starting', 'working', 'waiting-input', 'idle']) {
    assert.equal(isExternalSessionEnded(session('external', status)), false)
  }
  for (const status of ['done', 'error']) {
    assert.equal(isExternalSessionEnded(session('external', status)), true)
    assert.equal(isExternalSessionEnded(session('sdk', status)), false)
  }
})

test('list reconciliation removes missed exits but not newly launched or updated watches', () => {
  assert.deepEqual(missingExternalSessions({ old: 10 }, { old: 10 }, []), ['old'])
  assert.deepEqual(missingExternalSessions({ old: 10 }, { old: 11 }, []), [])
  assert.deepEqual(missingExternalSessions({}, { fresh: 1 }, []), [])
  assert.deepEqual(missingExternalSessions({ old: 10 }, {}, []), [])
  assert.deepEqual(
    missingExternalSessions({ session: 10 }, { session: 10 }, [session('external')]),
    []
  )
})

test('external observation failure is explicit without changing process status', () => {
  const running = session('external')
  assert.equal(terminalObservationIssue(running, 2000), null)
  assert.match(terminalObservationIssue(running, 20_000), /external Copilot terminal/)
  assert.equal(
    terminalObservationIssue({ ...running, observationError: 'Cannot read log' }, 2000),
    'Cannot read log'
  )
  assert.equal(terminalObservationIssue(session('sdk'), 20_000), null)
  assert.equal(terminalObservationIssue(session('external', 'done'), 20_000), null)
  assert.equal(running.status, 'working')
})

test('setting names identify the two supported destinations', () => {
  assert.equal(sessionLaunchModeLabel('sdk'), 'In-app chat')
  assert.equal(sessionLaunchModeLabel('external'), 'External Copilot terminal')
})
