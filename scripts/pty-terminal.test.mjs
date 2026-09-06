import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Buffer } from 'node:buffer'
import { setTimeout } from 'node:timers'
import ts from 'typescript'

const requireLibrary = createRequire(import.meta.url)

// Exercise the real terminal parser and registry without installing a DOM/test framework.
globalThis.window = globalThis
globalThis.document = {
  createElement: () => ({ className: '', parentElement: null, remove() {} })
}

const attachments = []
const writes = []
const acknowledgements = []
globalThis.api = {
  terminalSessions: {
    attach: async (target, attachment, callback) => {
      attachments.push({ target, attachment, callback })
    },
    acknowledge: async (...args) => {
      acknowledgements.push(args)
    },
    write: async (...args) => {
      writes.push(args)
    },
    resize: async () => {},
    detach: async () => {},
    stop: async () => {}
  }
}
const filename = resolve('src', 'renderer', 'src', 'lib', 'pty-terminal.ts')
const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const compiled = { exports: {} }
new Function('require', 'module', 'exports', outputText)(
  (name) => (name.endsWith('.css') ? {} : requireLibrary(name)),
  compiled,
  compiled.exports
)
const { terminalFor, syncTerminals, disposeTerminals, retainTerminals } = compiled.exports
const session = (id = 'one', generation = 'generation-1') => ({
  id,
  generation,
  transport: 'pty',
  status: 'working'
})
const send = (connection, seq, text, reset = false, ended = false, ready = true) =>
  connection.callback({
    attachment: connection.attachment,
    generation: connection.target.generation,
    seq,
    reset,
    replay: reset,
    ready,
    checkpointable: !reset,
    ended,
    rows: 24,
    cols: 80,
    data: [...Buffer.from(text)]
  })
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

afterEach(() => {
  disposeTerminals()
  attachments.length = 0
  writes.length = 0
  acknowledgements.length = 0
})

test('session switching keeps instances; a new generation replaces only its own terminal', async () => {
  const first = terminalFor(session())
  const second = terminalFor(session('two'))
  assert.equal(terminalFor(session()), first)
  syncTerminals([session(), session('two')])
  assert.equal(attachments.length, 2)
  const resumed = terminalFor(session('one', 'generation-2'))
  assert.notEqual(first, resumed)
  assert.equal(second, terminalFor(session('two')))
  await settle()
})

test('StrictMode effect replay retains the terminal until the provider truly unmounts', async () => {
  const release = retainTerminals()
  const terminal = terminalFor(session())
  release()
  const releaseRemount = retainTerminals()
  await settle()
  assert.equal(terminalFor(session()), terminal)
  releaseRemount()
  await settle()
  assert.notEqual(terminalFor(session()), terminal)
})

test('terminal uses a black palette before mounting and after checkpoint restoration', async () => {
  const terminal = terminalFor(session())
  const palette = {
    background: '#000000',
    foreground: '#e5e5e5',
    cursor: '#e5e5e5',
    cursorAccent: '#000000',
    selectionBackground: '#525252'
  }
  assert.deepEqual(terminal.terminal.options.theme, palette)
  send(attachments[0], 0, '\x1b[0mDefault text', true)
  await settle()
  assert.deepEqual(terminal.terminal.options.theme, palette)
  await terminal.connect()
  send(attachments[1], 1, '\x1b[0mRestored text', true)
  await settle()
  assert.deepEqual(terminal.terminal.options.theme, palette)
})

test('checkpoints suppress device responses; live queries respond to the correct process', async () => {
  const terminal = terminalFor(session())
  const connection = attachments[0]
  send(connection, 10, 'Question\r\n> alpha\r\n  beta\x1b[6n', true)
  await settle()
  assert.equal(terminal.getSnapshot().connected, true)
  assert.equal(writes.length, 0)
  send(connection, 11, '\x1b[6n')
  await settle()
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0].id, 'one')
  const response = Buffer.from(writes[0][1]).toString()
  assert.equal(response.charCodeAt(0), 27)
  assert.match(response.slice(1), /^\[\d+;\d+R$/)
})

test('output gaps disconnect visibly and old attachments cannot overwrite a reconnect', async () => {
  const terminal = terminalFor(session())
  const previous = attachments[0]
  send(previous, 1, 'initial', true)
  await settle()
  send(previous, 3, 'missing sequence')
  await settle()
  assert.equal(terminal.getSnapshot().connected, false)
  assert.match(terminal.getSnapshot().error, /interrupted/)
  send(previous, 2, 'late missing chunk')
  await settle()
  assert.equal(terminal.getSnapshot().connected, false)
  await terminal.connect()
  const current = attachments[1]
  send(previous, 50, 'stale', true)
  send(current, 100, 'current', true)
  await settle()
  assert.equal(terminal.getSnapshot().connected, true)
  assert.equal(terminal.getSnapshot().error, null)
  assert.equal(acknowledgements.at(-1)[1], current.attachment)
})

test('terminal input stays disabled until the full recovery stream is displayed', async () => {
  const terminal = terminalFor(session())
  const connection = attachments[0]
  send(connection, 0, 'Partial prompt', true, false, false)
  await settle()
  assert.equal(terminal.getSnapshot().connected, false)
  assert.equal(terminal.terminal.options.disableStdin, true)
  send(connection, 1, '\r\nQuestion and choices', false, false, true)
  await settle()
  assert.equal(terminal.getSnapshot().connected, true)
  assert.equal(terminal.terminal.options.disableStdin, false)
})

test('initial ConPTY device queries are answered before recovery enables user input', async () => {
  const terminal = terminalFor(session())
  const connection = attachments[0]
  send(connection, 0, '', true, false, false)
  send(connection, 1, '\x1b[6n', false, false, false)
  await settle()
  assert.equal(writes.length, 1)
  assert.equal(Buffer.from(writes[0][1]).toString(), '\x1b[1;1R')
  assert.equal(terminal.element.inert, true)
  assert.equal(terminal.getSnapshot().connected, false)
  send(connection, 2, 'Ready', false, false, true)
  await settle()
  assert.equal(terminal.element.inert, false)
  assert.equal(terminal.getSnapshot().connected, true)
})

test('a late output chunk cannot make an ended session interactive again', async () => {
  const terminal = terminalFor(session())
  const connection = attachments[0]
  send(connection, 1, 'initial', true)
  await settle()
  terminal.markEnded()
  send(connection, 2, 'final output')
  await settle()
  assert.equal(terminal.getSnapshot().ended, true)
  assert.equal(terminal.getSnapshot().connected, false)
  assert.equal(terminal.terminal.options.disableStdin, true)
})

test('xterm checkpoints restore an alternate-screen question and primary history', async () => {
  const terminal = terminalFor(session())
  const original = attachments[0]
  send(original, 0, '', true)
  send(original, 1, 'History\r\n\x1b[?1049h\x1b[?2004hQuestion\r\n> alpha\r\n  beta')
  await settle()
  const checkpoint = acknowledgements.at(-1)[3]
  assert.ok(checkpoint?.data)
  const before = terminal.terminal.buffer.active.getLine(0).translateToString(true)
  await terminal.connect()
  const restored = attachments[1]
  send(restored, 1, checkpoint.data, true)
  await settle()
  assert.equal(terminal.terminal.buffer.active.type, 'alternate')
  assert.equal(terminal.terminal.buffer.active.getLine(0).translateToString(true), before)
  send(restored, 2, '\x1b[?1049l')
  await settle()
  assert.equal(terminal.terminal.buffer.active.type, 'normal')
  assert.equal(terminal.terminal.buffer.active.getLine(0).translateToString(true), 'History')
})
