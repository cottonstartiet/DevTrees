import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const source = readFileSync(
  resolve('src', 'remote', 'src', 'session-timeline-presentation.ts'),
  'utf8'
)
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const compiled = { exports: {} }
new Function('module', 'exports', outputText)(compiled, compiled.exports)
const { remoteTimelinePresentation } = compiled.exports

const active = { sessionFinished: false, hasLiveInteraction: false }
const finished = { sessionFinished: true, hasLiveInteraction: false }

function present(entry, context = active) {
  return remoteTimelinePresentation({ seq: 1, timestamp: null, ...entry }, context)
}

test('conversation and notices remain visible', () => {
  assert.deepEqual(present({ kind: 'userMessage', text: 'Please continue' }), {
    display: 'message',
    role: 'user',
    text: 'Please continue'
  })
  assert.deepEqual(present({ kind: 'assistantMessage', text: 'Working on it' }), {
    display: 'message',
    role: 'assistant',
    text: 'Working on it'
  })
  assert.deepEqual(present({ kind: 'notice', level: 'error', text: 'Connection failed' }), {
    display: 'notice',
    tone: 'error',
    summary: 'Error',
    detail: 'Connection failed'
  })
})

test('in-flight tool calls are omitted until they become final', () => {
  const running = {
    kind: 'toolCall',
    toolCallId: 'tool-1',
    name: 'Read file',
    detail: '{"path":"a"}',
    success: null,
    result: null
  }
  assert.deepEqual(present(running), { display: 'omit' })
  assert.deepEqual(present(running, finished), {
    display: 'collapsed',
    outcome: 'failure',
    summary: 'Read file',
    status: 'did not complete'
  })
  assert.deepEqual(present({ ...running, success: true }), {
    display: 'collapsed',
    outcome: 'success',
    summary: 'Read file',
    status: 'completed'
  })
  assert.deepEqual(present({ ...running, success: false }), {
    display: 'collapsed',
    outcome: 'failure',
    summary: 'Read file',
    status: 'failed'
  })
})

test('permissions do not duplicate live interactions', () => {
  const permission = {
    kind: 'permission',
    description: 'Allow file update?',
    resolution: null,
    selectionKind: null
  }
  assert.deepEqual(present(permission), {
    display: 'waiting',
    summary: 'Permission needed',
    detail: 'Allow file update?'
  })
  assert.deepEqual(present(permission, { sessionFinished: false, hasLiveInteraction: true }), {
    display: 'omit'
  })
  assert.deepEqual(present({ ...permission, resolution: 'Allowed once' }), {
    display: 'collapsed',
    outcome: 'neutral',
    summary: 'Permission',
    status: 'Allowed once'
  })
})

test('ACP tool activity hides active states and preserves every final state', () => {
  for (const status of [undefined, null, '', 'pending', 'in_progress']) {
    assert.deepEqual(
      present({
        kind: 'acp',
        category: 'tool',
        data: { title: 'Run command', ...(status === undefined ? {} : { status }) }
      }),
      { display: 'omit' }
    )
  }

  for (const [status, outcome] of [
    ['completed', 'success'],
    ['failed', 'failure'],
    ['cancelled', 'failure'],
    ['incomplete', 'failure'],
    ['future_terminal_state', 'neutral']
  ]) {
    assert.deepEqual(
      present({
        kind: 'acp',
        category: 'tool',
        data: { title: 'Run command', status }
      }),
      {
        display: 'collapsed',
        outcome,
        summary: 'Run command',
        status
      }
    )
  }
})

test('ACP classification is lazy and keeps non-tool records collapsed', () => {
  let outputReads = 0
  const data = {
    title: 'Search code',
    status: 'completed',
    get rawOutput() {
      outputReads++
      return { text: 'large output' }
    }
  }
  assert.deepEqual(present({ kind: 'acp', category: 'tool', data }), {
    display: 'collapsed',
    outcome: 'success',
    summary: 'Search code',
    status: 'completed'
  })
  assert.equal(outputReads, 0)
  assert.deepEqual(present({ kind: 'acp', category: 'plan', data: { entries: [] } }), {
    display: 'collapsed',
    outcome: 'neutral',
    summary: 'Plan'
  })
  assert.deepEqual(present({ kind: 'acp', category: 'update', data: {} }), {
    display: 'collapsed',
    outcome: 'neutral',
    summary: 'Copilot activity'
  })
})
