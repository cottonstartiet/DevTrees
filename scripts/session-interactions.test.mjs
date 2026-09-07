import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const source = readFileSync(resolve('src', 'shared', 'native-session.ts'), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const compiled = { exports: {} }
new Function('module', 'exports', outputText)(compiled, compiled.exports)
const {
  acceptNativeSnapshot,
  endedNativeHistory,
  nativeKey,
  nativeFields,
  initialNativeDraft,
  nativeFormContent
} = compiled.exports
const snapshot = (generation, revision, interactions = []) => ({
  session: { id: 'same-session', generation, revision, transport: 'sdk' },
  interactions,
  entries: []
})

test('a late snapshot cannot resurrect an answered request or older owner', () => {
  const pending = snapshot('first', 2, [{ id: 'request' }])
  const answered = snapshot('first', 3)
  assert.equal(acceptNativeSnapshot(pending, answered), false)
  assert.equal(acceptNativeSnapshot(answered, pending), true)
  assert.equal(acceptNativeSnapshot(answered, snapshot('second', 4)), false)
  assert.equal(acceptNativeSnapshot(answered, undefined, snapshot('second', 4).session), false)
  assert.equal(
    acceptNativeSnapshot(snapshot('first', 4), undefined, snapshot('second', 4).session),
    false
  )
  assert.equal(acceptNativeSnapshot(snapshot('second', 4), answered), true)
})

test('draft and request identities include session, generation and opaque request id', () => {
  const session = snapshot('first', 1).session
  assert.notEqual(nativeKey(session, 'r1'), nativeKey(session, 'r2'))
  assert.notEqual(nativeKey(session, 'r1'), nativeKey({ ...session, generation: 'second' }, 'r1'))
  assert.notEqual(nativeKey(session), nativeKey(session, 'r1'))
})

test('ended native history cannot advertise old tools or permissions as live', () => {
  const entries = [
    { kind: 'toolCall', seq: 1, success: null, result: null },
    { kind: 'permission', seq: 2, resolution: null },
    { kind: 'toolCall', seq: 3, success: true, result: 'complete' },
    { kind: 'toolCall', seq: 4, success: false, result: 'denied' },
    { kind: 'permission', seq: 5, resolution: 'denied' },
    { kind: 'assistantMessage', seq: 6, text: 'preserved' }
  ]
  const projected = endedNativeHistory(entries)
  assert.equal(projected[0].success, false)
  assert.match(projected[0].result, /without a tool completion result/)
  assert.match(projected[1].resolution, /no longer active/)
  for (let index = 2; index < entries.length; index++) {
    assert.equal(projected[index], entries[index])
  }
  assert.equal(entries[0].success, null)
  assert.equal(entries[1].resolution, null)
})

test('forms preserve JSON types and do not silently select a first choice', () => {
  const fields = nativeFields({
    required: ['count'],
    properties: {
      name: { type: 'string', default: 'sample' },
      count: { type: 'integer', minimum: 1 },
      enabled: { type: 'boolean' },
      choice: { type: 'string', enum: ['alpha', 'beta'], enumNames: ['First', 'Second'] },
      tags: { type: 'array', items: { anyOf: [{ const: 'alpha', title: 'Alpha' }] } }
    }
  })
  assert.deepEqual(initialNativeDraft(fields), { name: 'sample' })
  assert.equal(fields.find((field) => field.name === 'choice').choices[0].label, 'First')
  assert.deepEqual(
    {
      ...nativeFormContent(fields, { count: '7', enabled: false, tags: ['alpha'], choice: 'beta' })
    },
    { count: 7, enabled: false, tags: ['alpha'], choice: 'beta' }
  )
  assert.throws(() => nativeFormContent(fields, {}), /required/)
  assert.throws(() => nativeFormContent(fields, { count: '' }), /required/)
  assert.throws(() => nativeFormContent(fields, { count: 'NaN' }), /whole number/)
  assert.throws(() => nativeFormContent(fields, { count: '1.5' }), /whole number/)
  assert.throws(() => nativeFormContent(fields, { count: '9007199254740993' }), /whole number/)
})

test('prototype-like field names are only submitted when explicitly answered', () => {
  const fields = nativeFields(
    JSON.parse('{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"}}}')
  )
  assert.deepEqual({ ...nativeFormContent(fields, {}) }, {})
  const draft = JSON.parse('{"__proto__":"safe","constructor":"value"}')
  assert.equal(nativeFormContent(fields, draft).__proto__, 'safe')
  assert.equal(nativeFormContent(fields, draft).constructor, 'value')
})

test('malformed forms fail visibly rather than rendering empty inputs', () => {
  for (const schema of [
    null,
    {},
    { properties: { nested: { type: 'object' } } },
    { properties: { choice: { type: 'string', enum: [1] } } }
  ]) {
    assert.throws(() => nativeFields(schema))
  }
})
