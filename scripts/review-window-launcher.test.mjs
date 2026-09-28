import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers'
import ts from 'typescript'

function compile(relativePath, requireModule = () => ({})) {
  const source = readFileSync(resolve(...relativePath), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const compiled = { exports: {} }
  new Function('module', 'exports', 'require', outputText)(
    compiled,
    compiled.exports,
    requireModule
  )
  return compiled.exports
}

const contract = compile(['src', 'renderer', 'src', 'lib', 'review-window.ts'])
const launcher = compile(
  ['src', 'renderer', 'src', 'lib', 'review-window-launcher.ts'],
  (moduleName) => {
    if (moduleName === '@/lib/review-window') return contract
    if (moduleName === '@tauri-apps/api/webviewWindow') {
      return { WebviewWindow: class TestWebviewWindow {} }
    }
    return {}
  }
)

const { createReviewWindowFacade, createReviewWindowLauncher, reviewWindowOptions } = launcher
const request = {
  kind: 'pr',
  folderPath: String.raw`C:\work\cockpit`,
  remoteKind: 'github',
  pullRequestId: 42,
  title: 'Review native windows'
}
const bounds = { left: 100, top: 50, width: 1920, height: 1080 }

function handle(log) {
  return {
    async unminimize() {
      log.push('unminimize')
    },
    async show() {
      log.push('show')
    },
    async setFocus() {
      log.push('focus')
    }
  }
}

test('window options use the shared transport and produce centered cascaded windows', () => {
  const first = reviewWindowOptions(request, bounds, 0)
  const second = reviewWindowOptions(request, bounds, 1)

  assert.equal(first.url, `/review.html${contract.serializeReviewWindowRequest(request)}`)
  assert.equal(first.title, contract.initialReviewWindowTitle(request))
  assert.deepEqual([first.x, first.y], [360, 140])
  assert.deepEqual([second.x, second.y], [388, 168])
  assert.equal(first.width, 1400)
  assert.equal(first.height, 900)
  assert.equal(first.minWidth, 900)
  assert.equal(first.minHeight, 600)
  assert.equal(first.resizable, true)
  assert.equal(first.skipTaskbar, false)
  assert.equal('parent' in first, false)
})

test('an existing matching window is restored, shown, and focused', async () => {
  const focusLog = []
  let createCalls = 0
  const open = createReviewWindowLauncher({
    async getByLabel() {
      return handle(focusLog)
    },
    async create() {
      createCalls += 1
      return handle([])
    },
    screenBounds: () => bounds
  })

  const result = await open(request)
  assert.deepEqual(result, {
    ok: true,
    label: contract.reviewWindowLabel(request),
    action: 'focused'
  })
  assert.deepEqual(focusLog, ['unminimize', 'show', 'focus'])
  assert.equal(createCalls, 0)
})

test('same-identity concurrent launches share one creation', async () => {
  let createCalls = 0
  let finishCreation
  const creation = new Promise((resolve) => {
    finishCreation = resolve
  })
  const open = createReviewWindowLauncher({
    async getByLabel() {
      return null
    },
    async create() {
      createCalls += 1
      await creation
      return handle([])
    },
    screenBounds: () => bounds
  })

  const first = open(request)
  const second = open({ ...request, title: 'A changed presentation title' })
  assert.equal(first, second)
  finishCreation()
  assert.equal((await first).action, 'created')
  assert.equal(createCalls, 1)
})

test('local launches for different branches use distinct windows', async () => {
  const labels = []
  const open = createReviewWindowLauncher({
    async getByLabel() {
      return null
    },
    async create(label) {
      labels.push(label)
      return handle([])
    },
    screenBounds: () => bounds
  })
  const localRequest = {
    kind: 'local',
    folderPath: String.raw`C:\work\cockpit`,
    branchLabel: 'main'
  }

  const first = await open(localRequest)
  const second = await open({ ...localRequest, branchLabel: 'feature/review-windows' })

  assert.equal(first.action, 'created')
  assert.equal(second.action, 'created')
  assert.notEqual(first.label, second.label)
  assert.deepEqual(labels, [first.label, second.label])
})

test('a create race focuses the window that won and failures stay explicit', async () => {
  const focusLog = []
  let lookups = 0
  const raceOpen = createReviewWindowLauncher({
    async getByLabel() {
      lookups += 1
      return lookups === 1 ? null : handle(focusLog)
    },
    async create() {
      throw new Error('label already exists')
    },
    screenBounds: () => bounds
  })

  assert.equal((await raceOpen(request)).action, 'focused')
  assert.deepEqual(focusLog, ['unminimize', 'show', 'focus'])

  const failedOpen = createReviewWindowLauncher({
    async getByLabel() {
      return null
    },
    async create() {
      throw new Error('creation denied')
    },
    screenBounds: () => bounds
  })
  const failure = await failedOpen({ kind: 'local', folderPath: String.raw`C:\work\cockpit` })
  assert.equal(failure.ok, false)
  assert.match(failure.error, /creation denied/)
})

test('encoded query limit failures are returned without creating an invalid window', async () => {
  let createCalls = 0
  const open = createReviewWindowLauncher({
    async getByLabel() {
      return null
    },
    async create() {
      createCalls += 1
      return handle([])
    },
    screenBounds: () => bounds
  })

  const failure = await open({
    kind: 'local',
    folderPath: 'é'.repeat(10_920)
  })

  assert.equal(failure.ok, false)
  assert.match(failure.error, /too large.*encoded query exceeds 65,536 characters/i)
  assert.equal(createCalls, 0)
})

test('facade keeps synchronous callers while mapping requests and reporting async failures', async () => {
  const requests = []
  const failures = []
  const facade = createReviewWindowFacade(
    async (next) => {
      requests.push(next)
      return next.kind === 'local'
        ? { ok: false, label: 'review-local-test', error: 'creation denied' }
        : { ok: true, label: 'review-pr-test', action: 'created' }
    },
    (error) => failures.push(error)
  )

  assert.equal(
    facade.openPrReview({
      folderPath: String.raw`C:\work\cockpit`,
      remoteKind: 'github',
      pullRequestId: 42,
      title: 'Review native windows'
    }),
    undefined
  )
  assert.equal(
    facade.openLocalReview({
      folderPath: String.raw`C:\work\cockpit`,
      branchLabel: 'feature/native-review'
    }),
    undefined
  )
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(requests, [
    request,
    {
      kind: 'local',
      folderPath: String.raw`C:\work\cockpit`,
      branchLabel: 'feature/native-review'
    }
  ])
  assert.deepEqual(failures, ['creation denied'])
})
