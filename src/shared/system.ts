export type LaunchResult = { ok: true } | { ok: false; error: string }

export type AppInfo = { name: string; version: string }

export type KeepAwakeResult =
  | { ok: true; enabled: boolean }
  | { ok: false; enabled: boolean; error: string }

export const SystemIpcChannels = {
  OpenInVSCode: 'system:open-in-vscode',
  OpenInVSCodeScm: 'system:open-in-vscode-scm',
  OpenInWindowsTerminal: 'system:open-in-windows-terminal',
  OpenExternal: 'system:open-external',
  OpenPath: 'system:open-path',
  GetAppInfo: 'system:get-app-info',
  GetKeepAwake: 'system:get-keep-awake',
  SetKeepAwake: 'system:set-keep-awake'
} as const
