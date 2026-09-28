import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(resolve('src', 'renderer', 'src', 'lib', 'review-window.ts'), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const compiled = { exports: {} }
new Function('module', 'exports', outputText)(compiled, compiled.exports)
const {
  initialReviewWindowTitle,
  parseReviewWindowRequest,
  reviewWindowLabel,
  serializeReviewWindowRequest
} = compiled.exports

test('PR and local requests round trip without losing optional presentation fields', () => {
  const requests = [
    {
      kind: 'pr',
      folderPath: String.raw`C:\work\100% ready\punctuation repo!\api.v2`,
      remoteKind: 'github',
      pullRequestId: 42,
      title: 'Fix query parsing & labels — 日本語'
    },
    {
      kind: 'local',
      folderPath: String.raw`\\server\share\très long project`,
      branchLabel: 'feature/review-windows-✓'
    }
  ]

  for (const request of requests) {
    assert.deepEqual(parseReviewWindowRequest(serializeReviewWindowRequest(request)), request)
  }
})

test('serializer accepts the encoded query boundary and rejects requests beyond it', () => {
  const boundaryRequest = {
    kind: 'local',
    folderPath: 'é'.repeat(10_919)
  }
  const boundaryQuery = serializeReviewWindowRequest(boundaryRequest)

  assert.equal(boundaryQuery.slice(1).length, 65_536)
  assert.deepEqual(parseReviewWindowRequest(boundaryQuery), boundaryRequest)

  const oversizedRequest = {
    kind: 'local',
    folderPath: 'é'.repeat(10_920)
  }
  assert.throws(
    () => serializeReviewWindowRequest(oversizedRequest),
    /too large.*encoded query exceeds 65,536 characters/i
  )
})

test('parser rejects malformed, incomplete, ambiguous, and unsupported requests', () => {
  const malformed = [
    '',
    '?kind=other&folderPath=C%3A%5Crepo',
    '?kind=pr&folderPath=C%3A%5Crepo&provider=gitlab&pullRequestId=1',
    '?kind=pr&folderPath=C%3A%5Crepo&provider=github',
    '?kind=pr&folderPath=C%3A%5Crepo&provider=github&pullRequestId=0',
    '?kind=pr&folderPath=C%3A%5Crepo&provider=github&pullRequestId=1.5',
    '?kind=pr&folderPath=C%3A%5Crepo&provider=github&pullRequestId=1&branchLabel=main',
    '?kind=local&folderPath=&branchLabel=main',
    '?kind=local&folderPath=C%3A%5Crepo&provider=github',
    '?kind=local&kind=pr&folderPath=C%3A%5Crepo',
    '?kind=local&folderPath=C%ZZrepo',
    '?kind=local&folderPath=C%3A%5Crepo&unexpected=value',
    `?kind=local&folderPath=${'a'.repeat(65_515)}`
  ]

  for (const query of malformed) {
    assert.equal(parseReviewWindowRequest(query), null, query)
  }
})

test('labels are legal, stable, path-sensitive, opaque, and identity-specific', () => {
  const base = {
    kind: 'pr',
    folderPath: String.raw`C:\work\repo.name`,
    remoteKind: 'ado',
    pullRequestId: 17
  }
  const label = reviewWindowLabel(base)

  assert.match(label, /^review-pr-[a-z0-9-]+$/)
  assert.equal(reviewWindowLabel({ ...base, title: 'A later title' }), label)
  assert.notEqual(reviewWindowLabel({ ...base, folderPath: String.raw`C:\work\repo-name` }), label)
  assert.notEqual(reviewWindowLabel({ ...base, remoteKind: 'github' }), label)
  assert.notEqual(reviewWindowLabel({ ...base, pullRequestId: 18 }), label)
  assert.notEqual(
    reviewWindowLabel({ kind: 'local', folderPath: base.folderPath, branchLabel: 'main' }),
    label
  )
  assert.doesNotMatch(label, /repo/i)
})

test('local labels distinguish branches while remaining normalized, stable, and legal', () => {
  const folderPath = String.raw`C:\work\repo.name`
  const main = { kind: 'local', folderPath, branchLabel: 'main' }
  const feature = { kind: 'local', folderPath, branchLabel: 'feature/review-windows' }
  const withoutBranch = { kind: 'local', folderPath }

  assert.match(reviewWindowLabel(main), /^review-local-[a-z0-9-]+$/)
  assert.equal(reviewWindowLabel(main), reviewWindowLabel({ ...main }))
  assert.notEqual(reviewWindowLabel(main), reviewWindowLabel(feature))
  assert.equal(
    reviewWindowLabel({ kind: 'local', folderPath, branchLabel: 'featur\u00e9' }),
    reviewWindowLabel({ kind: 'local', folderPath, branchLabel: 'feature\u0301' })
  )
  assert.equal(reviewWindowLabel(withoutBranch), reviewWindowLabel({ ...withoutBranch }))
})

test('native titles identify the review without exposing the full folder path', () => {
  const prTitle = initialReviewWindowTitle({
    kind: 'pr',
    folderPath: String.raw`C:\secret\customers\cockpit`,
    remoteKind: 'github',
    pullRequestId: 9,
    title: 'Improve review windows'
  })
  const localTitle = initialReviewWindowTitle({
    kind: 'local',
    folderPath: String.raw`C:\secret\customers\cockpit`,
    branchLabel: 'feature/native-review'
  })

  assert.equal(prTitle, 'cockpit — PR #9: Improve review windows')
  assert.equal(localTitle, 'cockpit — Local changes (feature/native-review)')
  assert.doesNotMatch(prTitle, /secret|customers/)
  assert.doesNotMatch(localTitle, /secret|customers/)
})
