import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const helperSource = readFileSync(
  resolve('src', 'renderer', 'src', 'lib', 'dashboard-prs.ts'),
  'utf8'
)
const { outputText } = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const compiled = { exports: {} }
new Function('module', 'exports', outputText)(compiled, compiled.exports)
const { findPrSourceWorktree, newestPrFirst, normalizePrBranch } = compiled.exports

const pr = {
  provider: 'github',
  id: 42,
  title: 'Dashboard authored PRs',
  description: '',
  author: 'octocat',
  sourceRef: 'refs/heads/feature/dashboard-prs',
  targetRef: 'main',
  webUrl: 'https://github.com/example/repo/pull/42',
  createdAt: '2026-09-28T10:00:00Z',
  isDraft: true,
  category: 'mine'
}

test('authored PR source branches resolve only to checked-out matching worktrees', () => {
  const worktrees = [
    {
      path: 'C:\\code\\repo',
      branch: 'main',
      head: '111',
      isDetached: false,
      isMain: true,
      isLocked: false
    },
    {
      path: 'C:\\code\\repo-dashboard-prs',
      branch: 'feature/dashboard-prs',
      head: '222',
      isDetached: false,
      isMain: false,
      isLocked: false
    }
  ]

  assert.equal(normalizePrBranch(pr.sourceRef), 'feature/dashboard-prs')
  assert.equal(findPrSourceWorktree(pr, worktrees)?.path, 'C:\\code\\repo-dashboard-prs')
  assert.equal(
    findPrSourceWorktree(pr, [
      {
        ...worktrees[1],
        branch: 'feature/dashboard-prs',
        isDetached: true
      }
    ]),
    null
  )
})

test('dashboard PR ordering is newest first and keeps drafts eligible', () => {
  const older = { ...pr, id: 1, createdAt: '2026-09-27T10:00:00Z', isDraft: false }
  const newerDraft = { ...pr, id: 2, createdAt: '2026-09-28T10:00:00Z', isDraft: true }
  const sorted = [older, newerDraft].sort(newestPrFirst)

  assert.deepEqual(
    sorted.map((item) => [item.id, item.isDraft]),
    [
      [2, true],
      [1, false]
    ]
  )
})

test('dashboard wiring keeps authored actions direct and automation assigned-only', () => {
  const hookSource = readFileSync(
    resolve('src', 'renderer', 'src', 'hooks', 'use-dashboard-pr-reviews.ts'),
    'utf8'
  )
  const dashboardSource = readFileSync(
    resolve('src', 'renderer', 'src', 'pages', 'dashboard.tsx'),
    'utf8'
  )

  assert.match(hookSource, /\.filter\(\(pr\) => pr\.category === 'mine'\)/)
  assert.match(hookSource, /processAutoReviews\(\s*nextAssignedItems,/)
  assert.match(dashboardSource, />Created by me</)
  assert.match(dashboardSource, />\s*Draft\s*</)
  assert.match(dashboardSource, /openPrReview\(\{/)
  assert.match(dashboardSource, /buildPrCommentsPrompt\(\{/)
  assert.match(dashboardSource, /folderPath: item\.sourceWorktree\.path/)
  assert.match(dashboardSource, /disabled=\{!item\.sourceWorktree \|\| isLaunching\}/)
})
