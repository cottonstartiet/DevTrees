import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const args = process.argv.slice(2)
const env = { ...process.env }

if (args[0] === 'dev' && !env.COPILOT_CLI_PATH) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(locator, ['copilot'], { encoding: 'utf8' })
  const copilotPath = result.stdout
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && existsSync(line))

  if (copilotPath) {
    env.COPILOT_CLI_PATH = copilotPath
    env.COPILOT_SKIP_CLI_DOWNLOAD = '1'
    process.stdout.write(`Using installed Copilot CLI for development: ${copilotPath}\n`)
  }
}

const tauriCli = fileURLToPath(
  new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url)
)
const result = spawnSync(process.execPath, [tauriCli, ...args], {
  env,
  stdio: 'inherit'
})

if (result.error) {
  process.stderr.write(`${result.error.message}\n`)
  process.exit(1)
}

process.exit(result.status ?? 1)
