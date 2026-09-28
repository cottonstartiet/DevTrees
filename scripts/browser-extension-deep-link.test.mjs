import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setImmediate } from 'node:timers'
import { test } from 'node:test'
import { URL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const popupSource = readFileSync(resolve('browser-extension', 'popup.js'), 'utf8')
const popupHtml = readFileSync(resolve('browser-extension', 'popup.html'), 'utf8')
const popupCss = readFileSync(resolve('browser-extension', 'popup.css'), 'utf8')
const deepLinkSource = readFileSync(
  resolve('src', 'renderer', 'src', 'lib', 'deep-links.ts'),
  'utf8'
)
const { outputText } = ts.transpileModule(deepLinkSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const compiled = { exports: {} }
new Function('module', 'exports', 'require', outputText)(compiled, compiled.exports, () => ({
  getCurrent: async () => null,
  onOpenUrl: async () => () => undefined
}))
const { parseSweFactoryDeepLink } = compiled.exports

function createElement() {
  const listeners = new Map()
  return {
    dataset: {},
    disabled: true,
    hidden: true,
    textContent: '',
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    click() {
      if (this.disabled) return
      listeners.get('click')?.()
    }
  }
}

async function openExtensionFor(url, title = 'Pull request') {
  const elements = new Map(
    ['#start-review', '#review-in-app', '#page-title', '#page-host', '#status'].map((selector) => [
      selector,
      createElement()
    ])
  )
  let assignedUrl = null

  vm.runInNewContext(popupSource, {
    URL,
    chrome: {
      tabs: {
        query: async () => [{ url, title }]
      }
    },
    document: {
      querySelector: (selector) => elements.get(selector)
    },
    window: {
      location: {
        assign(value) {
          assignedUrl = value
        }
      }
    }
  })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))

  elements.get('#review-in-app').click()
  return { elements, assignedUrl }
}

const supportedPullRequests = [
  {
    sourceUrl: 'https://github.com/cottonstartiet/DevTrees/pull/42',
    provider: 'github',
    organization: 'cottonstartiet',
    project: null,
    repositoryName: 'DevTrees',
    pullRequestId: 42
  },
  {
    sourceUrl: 'https://dev.azure.com/contoso/Platform/_git/Cockpit/pullrequest/17',
    provider: 'ado',
    organization: 'contoso',
    project: 'Platform',
    repositoryName: 'Cockpit',
    pullRequestId: 17
  },
  {
    sourceUrl: 'https://contoso.visualstudio.com/Platform/_git/Cockpit/pullrequest/9',
    provider: 'ado',
    organization: 'contoso',
    project: 'Platform',
    repositoryName: 'Cockpit',
    pullRequestId: 9
  }
]

test('Review in app emits a pull-request route accepted by the desktop parser', async () => {
  for (const expected of supportedPullRequests) {
    const { elements, assignedUrl } = await openExtensionFor(expected.sourceUrl)

    assert.equal(elements.get('#review-in-app').hidden, false)
    assert.equal(elements.get('#review-in-app').disabled, true)
    assert.ok(assignedUrl)

    const deepLink = new URL(assignedUrl)
    assert.equal(deepLink.protocol, 'swefactory:')
    assert.equal(deepLink.hostname, 'reviews')
    assert.equal(deepLink.pathname, '/pull-request')

    const action = parseSweFactoryDeepLink(assignedUrl)
    assert.deepEqual(
      {
        kind: action.kind,
        sourceUrl: action.sourceUrl,
        provider: action.provider,
        organization: action.organization,
        project: action.project,
        repositoryName: action.repositoryName,
        pullRequestId: action.pullRequestId
      },
      { kind: 'browser-pull-request-review', ...expected }
    )
  }
})

test('Review in app remains unavailable on unsupported browser pages', async () => {
  const { elements, assignedUrl } = await openExtensionFor(
    'https://github.com/cottonstartiet/DevTrees/issues/42'
  )

  assert.equal(elements.get('#review-in-app').hidden, true)
  assert.equal(elements.get('#review-in-app').disabled, true)
  assert.equal(assignedUrl, null)
})

test('browser extension actions share the primary button treatment', () => {
  assert.doesNotMatch(popupHtml, /class=["'][^"']*\bsecondary\b/)
  assert.doesNotMatch(popupCss, /button\.secondary/)
})
