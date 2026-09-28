import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const viteConfig = readFileSync(resolve('vite.config.ts'), 'utf8')
const mainCapability = JSON.parse(
  readFileSync(resolve('src-tauri', 'capabilities', 'default.json'), 'utf8')
)
const reviewCapability = JSON.parse(
  readFileSync(resolve('src-tauri', 'capabilities', 'review.json'), 'utf8')
)

test('Vite emits both Tauri renderer entry points with a relative asset base', () => {
  assert.match(viteConfig, /base:\s*['"]\.\/['"]/)
  assert.match(viteConfig, /main:\s*resolve\(__dirname,\s*['"]src\/renderer\/index\.html['"]\)/)
  assert.match(viteConfig, /review:\s*resolve\(__dirname,\s*['"]src\/renderer\/review\.html['"]\)/)
})

test('main window can create, find, restore, show, and focus review windows', () => {
  assert.deepEqual(mainCapability.windows, ['main'])
  for (const permission of [
    'core:window:allow-get-all-windows',
    'core:webview:allow-create-webview-window',
    'core:window:allow-show',
    'core:window:allow-set-focus',
    'core:window:allow-unminimize'
  ]) {
    assert.ok(mainCapability.permissions.includes(permission), permission)
  }
})

test('review windows receive only their app, event, close, and title permissions', () => {
  assert.equal(reviewCapability.identifier, 'review-windows')
  assert.deepEqual(reviewCapability.windows, ['review-*'])
  assert.deepEqual(reviewCapability.permissions, [
    'core:app:default',
    'core:event:default',
    'core:window:allow-close',
    'core:window:allow-set-title'
  ])
})
