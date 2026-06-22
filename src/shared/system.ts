export type LaunchResult = { ok: true } | { ok: false; error: string }

export type LaunchCopilotCliRequest = { folderPath: string; prompt: string }

export type AppInfo = { name: string; version: string }

export const SystemIpcChannels = {
  OpenInVSCode: 'system:open-in-vscode',
  OpenInVSCodeScm: 'system:open-in-vscode-scm',
  OpenInWindowsTerminal: 'system:open-in-windows-terminal',
  OpenExternal: 'system:open-external',
  OpenPath: 'system:open-path',
  LaunchCopilotCli: 'system:launch-copilot-cli',
  GetAppInfo: 'system:get-app-info'
} as const
