import { ipcMain } from 'electron'

import type {
  CopilotSession,
  CreateSessionRequest,
  CreateSessionResult,
  SessionInputMessage,
  SessionResizeMessage,
  SessionSnapshot
} from '../shared/sessions'
import { SessionIpcChannels } from '../shared/sessions'
import { copilotSessions } from './sessions'

export function registerSessionIpc(): void {
  ipcMain.handle(
    SessionIpcChannels.Create,
    async (_event, req: CreateSessionRequest): Promise<CreateSessionResult> => {
      try {
        const session = copilotSessions.create(req)
        return { ok: true, session }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to start session.' }
      }
    }
  )

  ipcMain.handle(
    SessionIpcChannels.List,
    async (): Promise<CopilotSession[]> => copilotSessions.list()
  )

  ipcMain.handle(
    SessionIpcChannels.Snapshot,
    async (_event, id: string): Promise<SessionSnapshot | null> => copilotSessions.snapshot(id)
  )

  ipcMain.handle(SessionIpcChannels.Kill, async (_event, id: string): Promise<void> => {
    await copilotSessions.kill(id)
  })

  ipcMain.on(SessionIpcChannels.Input, (_event, msg: SessionInputMessage) => {
    if (msg && typeof msg.id === 'string') copilotSessions.input(msg.id, msg.data)
  })

  ipcMain.on(SessionIpcChannels.Resize, (_event, msg: SessionResizeMessage) => {
    if (msg && typeof msg.id === 'string') copilotSessions.resize(msg.id, msg.cols, msg.rows)
  })
}
