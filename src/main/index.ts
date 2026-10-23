import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
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

/**
 * The window is painted by the compositor before the renderer has resolved an
 * appearance, so its background must match the palette the renderer will use.
 * These two values mirror `--ade-canvas` in `src/renderer/src/assets/main.css`
 * (A2 Graphite and A2 Paper); keep them in step if the canvas changes.
 */
const WINDOW_BACKGROUND = { dark: '#0C0D0F', light: '#F6F5F2' } as const

function windowBackground(useDark: boolean): string {
  return useDark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
}

/**
 * Keeps the native window background in step when the desktop appearance
 * changes mid-session. Registered once, after `ready`, so a second window on
 * macOS cannot install a duplicate listener.
 */
function watchSystemAppearance(): void {
  nativeTheme.on('updated', () => {
    const color = windowBackground(nativeTheme.shouldUseDarkColors)
    for (const window of BrowserWindow.getAllWindows()) {
      window.setBackgroundColor(color)
    }
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    show: process.env.ADE_BACKGROUND_LAUNCH !== '1',
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
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
      // Registered before the window exists so a live appearance change also
      // reaches the first window.
      watchSystemAppearance()
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
