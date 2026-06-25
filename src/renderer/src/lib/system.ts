import type {
  AppInfo,
  LaunchCopilotCliRequest,
  LaunchCopilotResumeRequest,
  LaunchResult
} from '@shared/system'

export function openInVSCode(folderPath: string): Promise<LaunchResult> {
  return window.api.system.openInVSCode(folderPath)
}

export function openInVSCodeScm(folderPath: string): Promise<LaunchResult> {
  return window.api.system.openInVSCodeScm(folderPath)
}

export function openInWindowsTerminal(folderPath: string): Promise<LaunchResult> {
  return window.api.system.openInWindowsTerminal(folderPath)
}

export function openExternal(url: string): Promise<LaunchResult> {
  return window.api.system.openExternal(url)
}

export function openPath(folderPath: string): Promise<LaunchResult> {
  return window.api.system.openPath(folderPath)
}

export function launchCopilotCli(req: LaunchCopilotCliRequest): Promise<LaunchResult> {
  return window.api.system.launchCopilotCli(req)
}

export function launchCopilotResume(req: LaunchCopilotResumeRequest): Promise<LaunchResult> {
  return window.api.system.launchCopilotResume(req)
}

export function getAppInfo(): Promise<AppInfo> {
  return window.api.system.getAppInfo()
}
