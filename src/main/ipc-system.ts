import { spawn } from 'node:child_process'

import { app, ipcMain, shell } from 'electron'

import type { AppInfo, LaunchCopilotCliRequest, LaunchResult } from '../shared/system'
import { SystemIpcChannels } from '../shared/system'

// Friendly product name shown in the UI. Kept separate from app.getName()
// (which returns the package.json `name`, "devtrees", and drives the userData
// path) so the displayed name can be capitalized without moving the app's data
// directory.
const APP_DISPLAY_NAME = 'DevTrees'

function launchDetached(command: string, args: string[]): Promise<LaunchResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        shell: true,
        windowsHide: true
      })
      let settled = false
      const settle = (result: LaunchResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      child.once('error', (err) => {
        settle({ ok: false, error: err.message })
      })
      child.once('spawn', () => {
        try {
          child.unref()
        } catch {
          /* noop */
        }
        settle({ ok: true })
      })
      setTimeout(() => settle({ ok: true }), 500)
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : 'spawn failed' })
    }
  })
}

async function openInVSCode(folderPath: string): Promise<LaunchResult> {
  const primary = await launchDetached('code', [folderPath])
  if (primary.ok) return primary

  try {
    const normalized = folderPath.replace(/\\/g, '/')
    const url = `vscode://file/${normalized.startsWith('/') ? normalized : '/' + normalized}`
    await shell.openExternal(url)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error:
        (primary.error ? `${primary.error}; ` : '') +
        (err instanceof Error ? err.message : 'failed to open VS Code')
    }
  }
}

/**
 * Open the folder in VS Code and focus the Source Control (SCM) view, which lists every
 * change and lets the user diff any file natively. Requires VS Code 1.82+ for `--command`;
 * if that launch fails we fall back to opening the folder normally.
 */
async function openInVSCodeScm(folderPath: string): Promise<LaunchResult> {
  const primary = await launchDetached('code', [folderPath, '--command', 'workbench.view.scm'])
  if (primary.ok) return primary
  return openInVSCode(folderPath)
}

async function openInWindowsTerminal(folderPath: string): Promise<LaunchResult> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Windows Terminal is only available on Windows.' }
  }
  return launchDetached('wt', ['-d', folderPath])
}

async function openExternalUrl(url: string): Promise<LaunchResult> {
  try {
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'Only http(s) URLs are allowed.' }
    }
    await shell.openExternal(url)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'openExternal failed' }
  }
}

async function openLocalPath(folderPath: string): Promise<LaunchResult> {
  if (typeof folderPath !== 'string' || folderPath.trim() === '') {
    return { ok: false, error: 'Path is required.' }
  }
  try {
    const errMessage = await shell.openPath(folderPath)
    if (errMessage) return { ok: false, error: errMessage }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'openPath failed' }
  }
}

async function launchCopilotCli({
  folderPath,
  prompt
}: LaunchCopilotCliRequest): Promise<LaunchResult> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Copilot CLI launch is currently Windows-only.' }
  }
  if (typeof folderPath !== 'string' || folderPath.trim() === '') {
    return { ok: false, error: 'folderPath is required.' }
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: 'prompt is required.' }
  }
  // The launched shell is Windows PowerShell 5.1, which does not escape embedded
  // double quotes when serializing an argument to a native executable (copilot.exe).
  // Pre-escape for Windows CRT argv (double the backslash run preceding a quote, then
  // escape the quote) so the multi-line prompt reaches copilot as a single argument.
  const nativeEscapedPrompt = prompt.replace(/(\\*)"/g, (_match, slashes: string) => {
    return `${slashes}${slashes}\\"`
  })
  const psEscapedPrompt = nativeEscapedPrompt.replace(/'/g, "''")
  const psCommand = `copilot --allow-all-tools -i '${psEscapedPrompt}'`
  const encoded = Buffer.from(psCommand, 'utf16le').toString('base64')
  return launchDetached('wt', [
    '-d',
    folderPath,
    'powershell',
    '-NoExit',
    '-EncodedCommand',
    encoded
  ])
}

export function registerSystemIpc(): void {
  ipcMain.handle(
    SystemIpcChannels.OpenInVSCode,
    async (_event, folderPath: string): Promise<LaunchResult> => openInVSCode(folderPath)
  )
  ipcMain.handle(
    SystemIpcChannels.OpenInVSCodeScm,
    async (_event, folderPath: string): Promise<LaunchResult> => openInVSCodeScm(folderPath)
  )
  ipcMain.handle(
    SystemIpcChannels.OpenInWindowsTerminal,
    async (_event, folderPath: string): Promise<LaunchResult> => openInWindowsTerminal(folderPath)
  )
  ipcMain.handle(
    SystemIpcChannels.OpenExternal,
    async (_event, url: string): Promise<LaunchResult> => openExternalUrl(url)
  )
  ipcMain.handle(
    SystemIpcChannels.OpenPath,
    async (_event, folderPath: string): Promise<LaunchResult> => openLocalPath(folderPath)
  )
  ipcMain.handle(
    SystemIpcChannels.LaunchCopilotCli,
    async (_event, req: LaunchCopilotCliRequest): Promise<LaunchResult> => launchCopilotCli(req)
  )
  ipcMain.handle(
    SystemIpcChannels.GetAppInfo,
    async (): Promise<AppInfo> => ({ name: APP_DISPLAY_NAME, version: app.getVersion() })
  )
}
