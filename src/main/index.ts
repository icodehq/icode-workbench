import { app, BrowserWindow, ipcMain, nativeTheme, screen } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gateHostStart, gateReattach, gateSqlite, runPackagedSmoke } from './gates/compat-gates'
import { getAppPersistence } from './persistence'
import { startAppRuntime } from './app/runtime'
import { registerAppIpc } from './ipc/register'
import { IPC_CHANNELS } from '../shared/schemas/ipc'
import { installApplicationMenu } from './menu'
import { clampWindowState, loadWindowState, trackWindowState } from './window-state'
import { APP_LOCAL_PROFILE_DIR_NAME, APP_NAME } from '../shared/domain/app-identity'

app.setName(APP_NAME)

const gateFlag = process.argv.find((arg) => arg.startsWith('--icode-gate-'))
const packagedSmoke = process.argv.includes('--icode-compat-smoke')

// Gate smoke runs need an isolated profile; the packaged check passes one in.
// Production resolves the canonical iCode profile explicitly instead of relying
// on Electron's name-derived default. `--user-data-dir` remains an explicit
// developer override and is never ignored.
const gateUserData = process.env.ICODE_GATE_USER_DATA
const userDataArg = process.argv.some((arg) => arg.startsWith('--user-data-dir'))
const profileDirectory =
  gateUserData ??
  (userDataArg
    ? app.getPath('userData')
    : join(app.getPath('appData'), APP_LOCAL_PROFILE_DIR_NAME))
mkdirSync(profileDirectory, { recursive: true })
app.setPath('userData', profileDirectory)
app.setPath('sessionData', profileDirectory)

app.disableHardwareAcceleration()

function installRuntimeInfoHandler(): void {
  ipcMain.handle('icode:runtime-info', () => ({
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
 * These two values mirror `--icode-canvas` in `src/renderer/src/assets/main.css`
 * (iCode canvas and paper); keep them in step if the canvas changes.
 */
const WINDOW_BACKGROUND = { dark: '#0A0E14', light: '#F6F8FA' } as const

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
  const backgroundLaunch = process.env.ICODE_BACKGROUND_LAUNCH === '1'
  const profileDirectory = app.getPath('userData')
  const saved = loadWindowState(profileDirectory)
  const initial = clampWindowState(saved, screen.getPrimaryDisplay().workAreaSize)
  const window = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    minWidth: 760,
    minHeight: 480,
    show: !backgroundLaunch,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    title: 'iCode Workbench',
    /**
     * The renderer owns the title bar and window controls. Keeping the default
     * thick frame preserves Windows resizing and the drop shadow without the
     * native caption or min/max/close buttons.
     */
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // The session workbench is terminal-first: a fresh profile opens maximized.
  // A hidden Host holder is infrastructure, not a user window, so it keeps its
  // offscreen bounds and never writes a window preference.
  const sendMaximizedState = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(IPC_CHANNELS.windowMaximizedEvent, window.isMaximized())
  }
  window.on('maximize', sendMaximizedState)
  window.on('unmaximize', sendMaximizedState)

  if (!backgroundLaunch) {
    // Track before maximizing so the startup state is persisted even if the
    // process is terminated without a normal close.
    trackWindowState(window, profileDirectory)
    if (saved.maximized) window.maximize()
  }

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
    case '--icode-gate-sqlite':
      await gateSqlite()
      return
    case '--icode-gate-host-start':
      await gateHostStart()
      return
    case '--icode-gate-reattach':
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
      process.stderr.write(`[icode] compatibility mode failed: ${String(error)}\n`)
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
      installApplicationMenu()
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
        process.stderr.write(`[icode] application services failed to start: ${String(error)}\n`)
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
