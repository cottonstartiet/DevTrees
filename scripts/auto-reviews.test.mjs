import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(resolve('src', 'renderer', 'src', 'lib', 'auto-reviews.ts'), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const compiled = { exports: {} }
new Function('module', 'exports', outputText)(compiled, compiled.exports)
const { AUTO_REVIEW_REFRESH_INTERVAL_MS, autoReviewKey, processAutoReviews } = compiled.exports

test('assigned reviews refresh every ten minutes and use stable case-insensitive keys', () => {
  assert.equal(AUTO_REVIEW_REFRESH_INTERVAL_MS, 10 * 60 * 1000)
  assert.equal(
    autoReviewKey('C:\\Code\\Repo', 'github', 42),
    autoReviewKey('c:\\code\\repo', 'github', 42)
  )
  assert.notEqual(
    autoReviewKey('C:\\Code\\Repo', 'github', 42),
    autoReviewKey('C:\\Code\\Repo', 'ado', 42)
  )
})

test('automatic review launches only after a successful one-time claim', async () => {
  const candidates = [{ key: 'new' }, { key: 'seen' }]
  const launched = []
  const statuses = {}

  const errors = await processAutoReviews(
    candidates,
    async (candidate) => candidate.key === 'new',
    async (candidate) => {
      launched.push(candidate.key)
      return { ok: true }
    },
    (candidate, status) => {
      ;(statuses[candidate.key] ??= []).push(status)
    }
  )

  assert.deepEqual(launched, ['new'])
  assert.deepEqual(statuses.new, ['checking', 'launching', 'started'])
  assert.deepEqual(statuses.seen, ['checking', 'already-triggered'])
  assert.deepEqual(errors, {})
})

test('a claimed review that fails to launch is reported without another launch attempt', async () => {
  let claimed = false
  let launches = 0
  const candidate = { key: 'review' }
  const claim = async () => {
    if (claimed) return false
    claimed = true
    return true
  }
  const launch = async () => {
    launches += 1
    return { ok: false, error: 'launch failed' }
  }

  assert.deepEqual(await processAutoReviews([candidate], claim, launch, () => {}), {
    review: 'launch failed'
  })
  assert.deepEqual(await processAutoReviews([candidate], claim, launch, () => {}), {})
  assert.equal(launches, 1)
})
