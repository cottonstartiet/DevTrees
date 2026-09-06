export type HostSettings = {
  launchAtSignIn: boolean
}

export type ToolAvailability = {
  available: boolean
  version: string | null
  error: string | null
}

export type HostStatus = {
  localUrl: string | null
  browserClients: number
  windowsTerminal: ToolAvailability
  copilotCli: ToolAvailability
}

export type UpdateStatus = {
  state: 'idle' | 'checking' | 'current' | 'available' | 'installing' | 'installed' | 'error'
  version?: string
  error?: string
}
