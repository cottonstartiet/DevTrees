import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const html = readFileSync(resolve('src', 'renderer', 'review.html'), 'utf8')
const entry = readFileSync(resolve('src', 'renderer', 'src', 'review-main.tsx'), 'utf8')
const app = readFileSync(resolve('src', 'renderer', 'src', 'review-app.tsx'), 'utf8')
const vite = readFileSync(resolve('vite.config.ts'), 'utf8')

test('review HTML boots only the dedicated renderer entry', () => {
  assert.match(html, /<script type="module" src="\/src\/review-main\.tsx"><\/script>/)
  assert.doesNotMatch(html, /src\/main\.tsx/)
  assert.match(vite, /review: resolve\(__dirname, ['"]src\/renderer\/review\.html['"]\)/)
})

test('review entry parses the URL and renders only review surfaces', () => {
  assert.match(entry, /<ReviewApp search=\{window\.location\.search\}/)
  assert.match(app, /parseReviewWindowRequest\(search\)/)
  assert.match(app, /<PrReviewPage/)
  assert.match(app, /<LocalReviewPage/)
  assert.doesNotMatch(entry, /from ['"]\.\/App['"]/)
  assert.doesNotMatch(app, /from ['"]\.\/App['"]/)
})

test('review entry provides theme, toasts, bootstrap, and visible failure states', () => {
  assert.match(entry, /import ['"]\.\/assets\/main\.css['"]/)
  assert.match(entry, /import ['"]\.\/lib\/api['"]/)
  assert.match(app, /<ThemeProvider>/)
  assert.match(app, /<Toaster /)
  assert.match(app, /role="alert"/)
  assert.match(app, /await getCurrentWindow\(\)\.close\(\)/)
  assert.match(app, /\.setTitle\(nativeTitle\)/)
  assert.match(app, /toast\.error\(['"]Unable to close the review window\./)
  assert.match(app, /toast\.error\(['"]Unable to update the review window title\./)
})
