import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const source = readFileSync(
  resolve('src', 'remote', 'src', 'session-card-presentation.ts'),
  'utf8'
)
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const compiled = { exports: {} }
new Function('module', 'exports', outputText)(compiled, compiled.exports)
const { sessionCardPresentation } = compiled.exports

const task = {
  id: 'task-1',
  title: 'Implement compact session cards'
}
const session = {
  id: 'session-1',
  taskId: task.id,
  label: 'Original session label',
  status: 'working',
  lastActivity: 'Reading several implementation files',
  pendingPrompt: null
}

test('normal task sessions show only the current task title', () => {
  assert.deepEqual(sessionCardPresentation(session, [task]), {
    title: task.title,
    detail: null
  })
})

test('sessions waiting for input expose the pending decision detail', () => {
  assert.deepEqual(
    sessionCardPresentation(
      {
        ...session,
        status: 'waiting-input',
        pendingPrompt: 'Allow Copilot to update the remote session component?'
      },
      [task]
    ),
    {
      title: task.title,
      detail: 'Allow Copilot to update the remote session component?'
    }
  )
})

test('waiting sessions fall back to activity and unlinked sessions keep their label', () => {
  assert.deepEqual(
    sessionCardPresentation(
      {
        ...session,
        taskId: null,
        status: 'waiting-input',
        pendingPrompt: '  ',
        lastActivity: 'Choose an implementation mode'
      },
      []
    ),
    {
      title: session.label,
      detail: 'Choose an implementation mode'
    }
  )
})
