import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { gateHostStart, gateReattach, gateSqlite, runPackagedSmoke } from './gates/compat-gates'
import { getAppPersistence } from './persistence'
import { startAppRuntime } from './app/runtime'
import { registerAppIpc } from './ipc/register'

const gateFlag = process.argv.find((arg) => arg.startsWith('--ade-gate-'))
const packagedSmoke = process.argv.includes('--ade-compat-smoke')

// Gate smoke runs need an isolated profile; the packaged check passes one in.
if (process.env.ADE_GATE_USER_DATA) {
  app.setPath('userData', process.env.ADE_GATE_USER_DATA)
}

app.disableHardwareAcceleration()

function installRuntimeInfoHandler(): void {
  ipcMain.handle('ade:runtime-info', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    platform: process.platform,
    packaged: app.isPackaged
  }))
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    show: process.env.ADE_BACKGROUND_LAUNCH !== '1',
    backgroundColor: '#0a0a0a',
    title: 'ADE',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function runCompatMode(): Promise<void> {
  installRuntimeInfoHandler()
  if (packagedSmoke) {
    await runPackagedSmoke()
    return
  }
  switch (gateFlag) {
    case '--ade-gate-sqlite':
      await gateSqlite()
      return
    case '--ade-gate-host-start':
      await gateHostStart()
      return
    case '--ade-gate-reattach':
      await gateReattach()
      return
    default:
      throw new Error(`Unknown compatibility mode: ${String(gateFlag)}`)
  }
}

if (gateFlag || packagedSmoke) {
  app
    .whenReady()
    .then(runCompatMode)
    .catch((error: unknown) => {
      process.stderr.write(`[ade] compatibility mode failed: ${String(error)}\n`)
      app.exit(1)
    })
} else {
  const lock = app.requestSingleInstanceLock()
  if (!lock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      const window = BrowserWindow.getAllWindows()[0]
      if (window) {
        if (window.isMinimized()) window.restore()
        window.focus()
      }
    })
    app.whenReady().then(async () => {
      // Diagnostics stay available even if persistence cannot open, so the
      // renderer can show an actionable error instead of a blank window.
      installRuntimeInfoHandler()
      try {
        const runtime = await startAppRuntime()
        registerAppIpc(runtime, () => getAppPersistence(), {
          ...(process.env.ELECTRON_RENDERER_URL
            ? { devServerUrl: process.env.ELECTRON_RENDERER_URL }
            : {})
        })
      } catch (error) {
        // A corrupt database is intentionally non-destructive: keep the window
        // usable so the failure can be surfaced instead of silently recreating.
        process.stderr.write(`[ade] application services failed to start: ${String(error)}\n`)
      }
      createWindow()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })
  }
}
