import type { TerminalSessionStatus } from './terminal-session'

export type EmbeddedTerminalKind = 'shell' | 'copilot'
export type EmbeddedTerminalPhase = 'starting' | 'running' | 'exited' | 'error'

export type EmbeddedTerminal = {
  terminalId: string
  kind: EmbeddedTerminalKind
  folderPath: string
  label: string
  repository?: string | null
  branch?: string | null
  taskId?: string | null
  copilotSessionId?: string | null
  phase: EmbeddedTerminalPhase
  status: TerminalSessionStatus
  lastActivity: string
  pendingPrompt?: string | null
  createdAt: number
  updatedAt: number
  exitCode?: number | null
  revision: number
}

export type EmbeddedTerminalStartRequest = {
  folderPath: string
  label: string
  repository?: string
  branch?: string
  taskId?: string
  cols: number
  rows: number
}

export type EmbeddedTerminalResult =
  | { ok: true; terminal: EmbeddedTerminal }
  | { ok: false; error: string }

export type EmbeddedTerminalOutput = {
  terminalId: string
  seq: number
  bytes: number[]
}

export type EmbeddedTerminalUpdate = {
  terminal: EmbeddedTerminal
}

export type EmbeddedTerminalReplay = {
  seq: number
  bytes: number[]
  truncated: boolean
}

export type EmbeddedDirectoryEntry = {
  name: string
  path: string
}
