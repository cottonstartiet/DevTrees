import { BrowserWindow, dialog, ipcMain } from 'electron'

import type { AddWorkspaceResult, Workspace } from '../shared/workspace'
import { WorkspaceIpcChannels } from '../shared/workspace'
import { addWorkspace, loadWorkspaces, removeWorkspace } from './workspaces'

export function registerWorkspaceIpc(): void {
  ipcMain.handle(WorkspaceIpcChannels.PickAndAdd, async (event): Promise<AddWorkspaceResult> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = win
      ? await dialog.showOpenDialog(win, {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Add workspace folder'
        })
      : await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          title: 'Add workspace folder'
        })

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' }
    }

    try {
      return await addWorkspace(result.filePaths[0])
    } catch (err) {
      console.error('[workspaces] addWorkspace failed:', err)
      return {
        ok: false,
        error: 'unknown',
        message: err instanceof Error ? err.message : 'Failed to add workspace.'
      }
    }
  })

  ipcMain.handle(WorkspaceIpcChannels.List, async (): Promise<Workspace[]> => {
    return loadWorkspaces()
  })

  ipcMain.handle(WorkspaceIpcChannels.Remove, async (_event, id: string): Promise<Workspace[]> => {
    return removeWorkspace(id)
  })
}
