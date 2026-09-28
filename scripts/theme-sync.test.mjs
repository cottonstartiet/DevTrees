import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(resolve('src', 'renderer', 'src', 'lib', 'theme-sync.ts'), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const compiled = { exports: {} }
new Function('module', 'exports', 'require', outputText)(compiled, compiled.exports, () => ({}))

const { isThemeSyncPayload } = compiled.exports

test('theme synchronization accepts only explicit supported theme changes', () => {
  assert.equal(isThemeSyncPayload({ source: 'main', theme: 'dark' }), true)
  assert.equal(isThemeSyncPayload({ source: 'review', colorTheme: 'enterprise' }), true)
  assert.equal(
    isThemeSyncPayload({ source: 'main', theme: 'system', colorTheme: 'chalk' }),
    true
  )
  assert.equal(isThemeSyncPayload({ source: '', theme: 'dark' }), false)
  assert.equal(isThemeSyncPayload({ source: 'main' }), false)
  assert.equal(isThemeSyncPayload({ source: 'main', theme: 'sepia' }), false)
  assert.equal(isThemeSyncPayload({ source: 'main', colorTheme: 'velocity' }), false)
})

test('theme synchronization uses a Tauri event and guards against event loops', () => {
  assert.match(source, /swe-factory:\/\/theme-changed/)
  assert.match(source, /event\.payload\.source !== source/)
  assert.match(source, /'__TAURI_INTERNALS__' in globalThis/)
})
