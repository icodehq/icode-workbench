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
import { installWindowCloseGuard } from './window-close'
import { applyLoginEnvironment } from './app/login-environment'
import { APP_LOCAL_PROFILE_DIR_NAME, APP_NAME } from '../shared/domain/app-identity'
import { LocaleService } from './i18n/locale-service'
import { setMainLocale } from './i18n/main-i18n'
import type { Locale } from '../shared/i18n'

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

/**
 * Language preference is read from the profile before any UI exists. The
 * resolved locale drives the native menu, dialogs, notifications, and the
 * renderer's first paint; changing it later rebuilds the menu and reaches every
 * open window without a restart.
 */
const localeService = new LocaleService({
  directory: profileDirectory,
  systemLanguages: () => [app.getPreferredSystemLanguages(), app.getLocale()].flat(),
  onChange: (state) => {
    setMainLocale(state.locale)
    installApplicationMenu(state.locale)
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send(IPC_CHANNELS.localeChangedEvent, state)
    }
  }
})
setMainLocale(localeService.locale)

// WSLg needs software rendering; Windows and macOS keep hardware acceleration.
const disableGpu =
  process.env.ICODE_DISABLE_GPU === '1' ||
  (process.platform === 'linux' && process.env.ICODE_ENABLE_GPU !== '1')
if (disableGpu) app.disableHardwareAcceleration()

function installRuntimeInfoHandler(localeService?: LocaleService): void {
  ipcMain.handle('icode:runtime-info', () => {
    const locale = localeService?.state()
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      platform: process.platform,
      packaged: app.isPackaged,
      locale: locale?.locale ?? 'en',
      systemLocale: locale?.systemLocale ?? 'en'
    }
  })
}

/**
 * The window is painted by the compositor before the renderer has resolved an
 * appearance, so its background must match the palette the renderer will use.
 * These two values mirror `--icode-canvas` in `src/renderer/src/assets/main.css`
 * (iCode canvas and paper); keep them in step if the canvas changes.
 */
const WINDOW_BACKGROUND = { dark: '#212121', light: '#FAFAFA' } as const

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

function createWindow(locale: Locale): void {
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
     * Windows/Linux: the renderer owns the title bar and custom controls; the
     * default thick frame preserves resizing and the drop shadow.
     * macOS: keep the native traffic lights and reserve space for them.
     */
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 12, y: 12 }
        }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The preload reads this before the renderer mounts, so the first frame
      // is painted in the selected language without an async IPC round-trip.
      additionalArguments: [`--icode-locale=${locale}`]
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
  installWindowCloseGuard(window, { enabled: !backgroundLaunch })

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
    .then(async () => {
      await applyLoginEnvironment()
      await runCompatMode()
    })
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
      // Resolve the login environment before the Host, harness detection, Git,
      // or any PTY reads process.env.
      await applyLoginEnvironment()
      // Registered before the window exists so a live appearance change also
      // reaches the first window.
      watchSystemAppearance()
      // The OS language is authoritative only after `ready`; re-resolve here so
      // the menu, first window argument and renderer agree on one locale.
      const startupLocale = localeService.state().locale
      setMainLocale(startupLocale)
      installApplicationMenu(startupLocale)
      // Diagnostics stay available even if persistence cannot open, so the
      // renderer can show an actionable error instead of a blank window.
      installRuntimeInfoHandler(localeService)
      try {
        const runtime = await startAppRuntime()
        registerAppIpc(runtime, () => getAppPersistence(), {
          locale: localeService,
          ...(process.env.ELECTRON_RENDERER_URL
            ? { devServerUrl: process.env.ELECTRON_RENDERER_URL }
            : {})
        })
      } catch (error) {
        // A corrupt database is intentionally non-destructive: keep the window
        // usable so the failure can be surfaced instead of silently recreating.
        process.stderr.write(`[icode] application services failed to start: ${String(error)}\n`)
      }
      createWindow(startupLocale)
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow(localeService.locale)
      })
    })
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })
  }
}
