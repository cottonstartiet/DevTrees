import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { closeDb, getDb } from './db'
import { registerWorkspaceIpc } from './ipc-workspaces'
import { registerWorktreeIpc } from './ipc-worktrees'
import { registerRepoIpc } from './ipc-repo'
import { registerSystemIpc } from './ipc-system'
import { registerSessionIpc } from './ipc-sessions'
import { copilotSessions } from './sessions'
import { registerAdoIpc } from './ipc-ado'
import { initAutoUpdater } from './updater'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// A second launch should focus the existing window instead of starting a new
// instance — important for auto-update, which installs on quit and can misbehave
// if multiple instances race to install.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.xbox.devtrees')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    getDb()
    registerWorkspaceIpc()
    registerWorktreeIpc()
    registerRepoIpc()
    registerSystemIpc()
    registerSessionIpc()
    registerAdoIpc()

    createWindow()

    initAutoUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('before-quit', () => {
  copilotSessions.killAll()
  closeDb()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
