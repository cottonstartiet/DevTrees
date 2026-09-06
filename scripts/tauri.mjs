import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const args = process.argv.slice(2)

const tauriCli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url))
const result = spawnSync(process.execPath, [tauriCli, ...args], {
  env: process.env,
  stdio: 'inherit'
})

if (result.error) {
  process.stderr.write(`${result.error.message}\n`)
  process.exit(1)
}

process.exit(result.status ?? 1)
