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
  parsePromptAttachments,
  rekeyNativeState,
  nativeFields,
  initialNativeDraft,
  nativeFormContent,
  nativeSessionNeedsUserAction,
  nativeSessionPresentationStatus,
  nativeSessionCanReplyToPlan,
  acpPermissionOptionIsRemembered,
  acpPermissionOptionScope,
  acpCommandQuery,
  matchingAcpCommands,
  acpCommandDraft
} = compiled.exports
const snapshot = (generation, revision, interactions = []) => ({
  session: { id: 'same-session', generation, revision, transport: 'acp' },
  interactions,
  entries: []
})

test('attachment drafts validate content without throwing from a React updater', () => {
  assert.ok(parsePromptAttachments('{').error)
  assert.ok(parsePromptAttachments('[{"type":"resource","resource":null}]').error)
  assert.ok(parsePromptAttachments('[{"type":"image","data":12}]').error)
  const blocks = [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }]
  assert.deepEqual(parsePromptAttachments(JSON.stringify(blocks)).content, blocks)
})

test('provisional rekey preserves drafts without overwriting a newer real-session draft', () => {
  const previous = { id: 'launch', generation: 'runtime' }
  const actual = { id: 'opaque-agent-id', generation: 'runtime' }
  const draft = { message: 'retained', literal: true }
  const original = { [nativeKey(previous)]: draft }
  const rekeyed = rekeyNativeState(original, previous.id, actual)
  assert.equal(rekeyed[nativeKey(actual)], draft)
  assert.equal(rekeyed[nativeKey(previous)], undefined)
  assert.equal(original[nativeKey(previous)], draft)
  const newer = { message: 'newer' }
  assert.equal(
    rekeyNativeState({ ...original, [nativeKey(actual)]: newer }, previous.id, actual)[
      nativeKey(actual)
    ],
    newer
  )
})

test('ended ACP tool progress is explicitly incomplete', () => {
  const result = endedNativeHistory([
    { kind: 'acp', category: 'tool', data: { status: 'in_progress' } }
  ])
  assert.equal(result[0].data.status, 'incomplete')
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

test('session attention follows live status and current native interactions', () => {
  const session = {
    id: 'same-session',
    generation: 'current',
    transport: 'acp',
    status: 'working'
  }
  assert.equal(nativeSessionNeedsUserAction({ ...session, status: 'waiting-input' }), true)
  assert.equal(
    nativeSessionNeedsUserAction(session, snapshot('current', 1, [{ id: 'request' }])),
    true
  )
  assert.equal(
    nativeSessionNeedsUserAction(session, snapshot('stale', 1, [{ id: 'request' }])),
    false
  )
  assert.equal(
    nativeSessionNeedsUserAction(
      { ...session, status: 'done' },
      snapshot('current', 1, [{ id: 'request' }])
    ),
    false
  )
  assert.equal(nativeSessionNeedsUserAction(session, snapshot('current', 1)), false)
})

test('session attention includes a current native plan transition', () => {
  const session = {
    id: 'same-session',
    generation: 'current',
    transport: 'acp',
    status: 'idle'
  }
  const planSnapshot = {
    ...snapshot('current', 1),
    planTransitionAvailable: true
  }
  assert.equal(nativeSessionNeedsUserAction(session, planSnapshot), true)
  assert.equal(
    nativeSessionNeedsUserAction(session, {
      ...planSnapshot,
      session: { ...planSnapshot.session, generation: 'stale' }
    }),
    false
  )
  assert.equal(nativeSessionNeedsUserAction({ ...session, status: 'done' }, planSnapshot), false)
  assert.equal(
    nativeSessionNeedsUserAction({ ...session, transport: 'external' }, planSnapshot),
    false
  )
})

test('session presentation promotes current action-required states without changing ordinary idle', () => {
  const session = {
    id: 'same-session',
    generation: 'current',
    transport: 'acp',
    status: 'idle'
  }
  const planSnapshot = {
    ...snapshot('current', 1),
    planTransitionAvailable: true
  }
  assert.equal(nativeSessionPresentationStatus(session, planSnapshot), 'waiting-input')
  assert.equal(nativeSessionPresentationStatus(session, snapshot('current', 1)), 'idle')
  assert.equal(
    nativeSessionPresentationStatus(session, {
      ...planSnapshot,
      session: { ...planSnapshot.session, generation: 'stale' }
    }),
    'idle'
  )
  assert.equal(
    nativeSessionPresentationStatus({ ...session, transport: 'external' }, planSnapshot),
    'idle'
  )
  assert.equal(
    nativeSessionPresentationStatus({ ...session, status: 'done' }, planSnapshot),
    'done'
  )
})

test('ACP permission choices expose one-time and remembered scope accurately', () => {
  assert.equal(acpPermissionOptionScope('allow_once'), 'Allows only this operation.')
  assert.equal(
    acpPermissionOptionScope('allow_always'),
    'Copilot remembers this choice for matching requests.'
  )
  assert.equal(acpPermissionOptionScope('reject_once'), 'Rejects only this operation.')
  assert.equal(
    acpPermissionOptionScope('reject_always'),
    'Copilot remembers this rejection for matching requests.'
  )
  assert.equal(
    acpPermissionOptionScope('future_scope'),
    'Copilot controls the scope of this choice.'
  )
  assert.equal(acpPermissionOptionIsRemembered('allow_always'), true)
  assert.equal(acpPermissionOptionIsRemembered('reject_always'), true)
  assert.equal(acpPermissionOptionIsRemembered('allow_once'), false)
})

test('plan replies are available only for the current idle decision without structured input', () => {
  const session = {
    id: 'same-session',
    generation: 'current',
    transport: 'acp',
    status: 'idle'
  }
  const planSnapshot = {
    ...snapshot('current', 1),
    planTransitionAvailable: true
  }
  assert.equal(nativeSessionCanReplyToPlan(session, planSnapshot), true)
  assert.equal(
    nativeSessionCanReplyToPlan(session, {
      ...planSnapshot,
      interactions: [{ id: 'structured-request' }]
    }),
    false
  )
  assert.equal(
    nativeSessionCanReplyToPlan(session, {
      ...planSnapshot,
      session: { ...planSnapshot.session, generation: 'stale' }
    }),
    false
  )
  assert.equal(nativeSessionCanReplyToPlan({ ...session, status: 'done' }, planSnapshot), false)
  assert.equal(
    nativeSessionCanReplyToPlan({ ...session, transport: 'external' }, planSnapshot),
    false
  )
})

test('slash command suggestions only match a leading command name', () => {
  const commands = [
    { name: 'usage', description: 'Show token usage' },
    { name: 'review', description: 'Review the current changes', input: { hint: '<focus>' } }
  ]
  assert.equal(acpCommandQuery('/'), '')
  assert.equal(acpCommandQuery('/US'), 'us')
  assert.equal(acpCommandQuery(' /usage'), null)
  assert.equal(acpCommandQuery('/usage now'), null)
  assert.deepEqual(matchingAcpCommands('/', commands), commands)
  assert.deepEqual(matchingAcpCommands('/tok', commands), [commands[0]])
  assert.deepEqual(matchingAcpCommands('/REV', commands), [commands[1]])
  assert.deepEqual(matchingAcpCommands('/missing', commands), [])
})

test('selected slash commands preserve advertised argument hints', () => {
  assert.equal(acpCommandDraft({ name: 'usage', description: '' }), '/usage')
  assert.equal(
    acpCommandDraft({ name: 'review', description: '', input: { hint: '<focus>' } }),
    '/review '
  )
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
