import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { setTimeout, clearTimeout } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'vite'

const { fetch, WebSocket } = globalThis

test(
  'embedded renderer recovers input and survives async state races',
  { timeout: 90_000 },
  async (t) => {
    const browser =
      process.env.DEVTREES_TEST_BROWSER ??
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    await access(browser)
    const directory = await mkdtemp(join(tmpdir(), 'devtrees-ui-'))
    let child
    let socket
    t.after(async () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: 9999, method: 'Browser.close' }))
        await delay(500)
        socket.close()
      }
      if (child && child.exitCode === null) child.kill()
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })
    await build({
      configFile: resolve('vite.config.ts'),
      root: process.cwd(),
      logLevel: 'error',
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: directory,
        emptyOutDir: false,
        sourcemap: false,
        lib: {
          entry: resolve('scripts', 'ui-regressions.tsx'),
          name: 'UiRegressions',
          formats: ['iife'],
          fileName: () => 'probe.js',
          cssFileName: 'probe'
        }
      }
    })
    const bundle = await readFile(join(directory, 'probe.js'), 'utf8')
    assert.equal(
      (bundle.match(/dismissableLayer\.update/g) ?? []).length,
      1,
      'Duplicated modal managers in Vite output'
    )
    assert.equal(
      (bundle.match(/focusScope\.autoFocusOnMount/g) ?? []).length,
      1,
      'Duplicated focus managers in Vite output'
    )
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="probe.css"></head><body><script>window.uiRegressionErrors=[];window.addEventListener("error",event=>window.uiRegressionErrors.push(event.message))</script><script src="probe.js"></script></body></html>'
    )
    const profile = join(directory, 'profile')
    child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        pathToFileURL(join(directory, 'index.html')).href
      ],
      { stdio: 'ignore' }
    )
    const started = Date.now()
    let port
    while (!port && Date.now() - started < 10_000) {
      try {
        port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await delay(50)
      }
    }
    assert.ok(port, 'Headless browser did not start')
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = pages.find((item) => item.type === 'page')
    assert.ok(page, 'Browser has no target page')
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((done, fail) => {
      socket.addEventListener('open', done, { once: true })
      socket.addEventListener('error', fail, { once: true })
    })
    let id = 0
    async function evaluate(expression) {
      const requestId = ++id
      return new Promise((done, fail) => {
        const timer = setTimeout(() => {
          socket.removeEventListener('message', receive)
          fail(new Error('Browser evaluation timed out'))
        }, 20_000)
        function receive(event) {
          const reply = JSON.parse(event.data)
          if (reply.id !== requestId) return
          clearTimeout(timer)
          socket.removeEventListener('message', receive)
          if (reply.error) fail(new Error(reply.error.message))
          else if (reply.result.exceptionDetails)
            fail(new Error(JSON.stringify(reply.result.exceptionDetails)))
          else done(reply.result.result.value)
        }
        socket.addEventListener('message', receive)
        socket.send(
          JSON.stringify({
            id: requestId,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true }
          })
        )
      })
    }
    // The target can initially expose the about:blank execution context.
    await delay(1000)
    assert.equal(
      await evaluate('typeof window.uiRegressions'),
      'object',
      `Regression entrypoint did not load: ${JSON.stringify(await evaluate('window.uiRegressionErrors'))}`
    )
    const reports = await evaluate('window.uiRegressions')
    for (const report of reports) {
      if (report.metrics) t.diagnostic(`${report.name}: ${JSON.stringify(report.metrics)}`)
      assert.equal(report.error, undefined, `${report.name}: ${report.error}`)
    }
    assert.equal(reports.length, 8)
  }
)
