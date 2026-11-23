import { existsSync } from 'node:fs'
import { CancellationToken } from 'builder-util-runtime'
import { makeAppError, type AppError } from '../../shared/domain/errors'
import type { UpdateProgress } from '../../shared/schemas/updates'
import type { UpdateLogger } from './update-log'

/**
 * electron-updater's private net-session partition.
 *
 * It is electron-updater's `NET_SESSION_NAME` (stable across 6.x). The app's
 * proxy runtime configures this session explicitly; otherwise a manual proxy
 * applied to `session.defaultSession` would cover checks but not downloads.
 */
export const UPDATE_NET_SESSION_PARTITION = 'electron-updater'

/**
 * The electron-updater adapter for the platforms where the app can replace
 * itself (Windows NSIS and a packaged AppImage).
 *
 * The import is dynamic on purpose: notify-only builds (macOS, deb/rpm) must
 * never construct electron-updater's platform updater or depend on
 * `app-update.yml` being readable for a check.
 */

type DownloadProgressEvent = {
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

type UpdateCheckResultLike = {
  updateInfo?: { version?: string }
}

type ErrorListener = (error: Error) => void

type AutoUpdaterLike = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  autoRunAppAfterInstall: boolean
  disableWebInstaller?: boolean
  /** electron-updater's downloaded installer; BaseUpdater exposes this getter. */
  installerPath?: string | null
  logger: unknown
  setFeedURL(options: unknown): void
  on(event: 'download-progress', listener: (payload: DownloadProgressEvent) => void): void
  on(event: 'error', listener: ErrorListener): void
  removeListener(
    event: 'download-progress',
    listener: (payload: DownloadProgressEvent) => void
  ): void
  removeListener(event: 'error', listener: ErrorListener): void
  checkForUpdates(token?: CancellationToken): Promise<UpdateCheckResultLike | null>
  downloadUpdate(token?: CancellationToken): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export type UpdateBackend = {
  /** Re-checks the feed (electron-updater is authoritative) and downloads. */
  download(onProgress: (progress: UpdateProgress) => void): Promise<{ version: string }>
  /** Aborts an in-flight check/download. Safe when nothing is running. */
  cancel(): void
  /**
   * Fails when electron-updater has no downloaded installer to run.
   *
   * Called before the window is destroyed: electron-updater's `quitAndInstall`
   * only dispatches an error event when its helper is missing, and the app
   * would otherwise quit with nothing to install.
   */
  assertInstallable(): void
  /** The downloaded installer path, for the durable update journal. */
  installerPath(): string | null
  /** Silent install followed by a relaunch. Only valid after `download`. */
  quitAndInstall(): void
  /** Stops forwarding events; a queued installer remains usable. */
  dispose(): void
}

function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { retryable?: unknown }).retryable === 'boolean'
  )
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function toProgress(payload: DownloadProgressEvent): UpdateProgress {
  const percent = Math.min(100, Math.max(0, numberOrZero(payload.percent)))
  return {
    percent,
    transferred: numberOrZero(payload.transferred),
    total: numberOrZero(payload.total),
    bytesPerSecond: numberOrZero(payload.bytesPerSecond)
  }
}

function downloadFailed(detail: string): AppError {
  return makeAppError('UPDATE_DOWNLOAD_FAILED', 'Could not download the update.', {
    detail,
    messageKey: 'updates.error.downloadFailed'
  })
}

export type UpdateBackendOptions = {
  /**
   * Test/mirror override. Production leaves it null and reads app-update.yml
   * (the GitHub provider). The runtime only supplies an http(s) base URL.
   */
  feedBaseUrl?: string | null
  logger?: UpdateLogger
  /** Bound on the updater's metadata check. */
  checkTimeoutMs?: number
  /** Cancel the download when no progress arrives for this long. */
  downloadIdleTimeoutMs?: number
  /** Test seam for the installer existence check. */
  fileExists?: (path: string) => boolean
}

const DEFAULT_CHECK_TIMEOUT_MS = 60_000
const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 2 * 60_000

export function createUpdateBackend(options: UpdateBackendOptions = {}): UpdateBackend {
  let updater: AutoUpdaterLike | null = null
  let activeToken: CancellationToken | null = null
  const logger: UpdateLogger = options.logger ?? {
    info: (...args: unknown[]) => console.info('[updates]', ...args),
    warn: (...args: unknown[]) => console.warn('[updates]', ...args),
    error: (...args: unknown[]) => console.error('[updates]', ...args),
    debug: (...args: unknown[]) => console.debug('[updates]', ...args)
  }
  const fileExists = options.fileExists ?? existsSync

  async function load(): Promise<AutoUpdaterLike> {
    if (updater !== null) return updater
    const module = await import('electron-updater')
    // electron-updater is CommonJS and defines `autoUpdater` with a getter.
    // Node's dynamic-import interop may expose it only on `default`, so accept
    // both shapes instead of assuming the named export exists.
    const namespace = module as unknown as {
      autoUpdater?: AutoUpdaterLike
      default?: { autoUpdater?: AutoUpdaterLike }
    }
    const instance = namespace.autoUpdater ?? namespace.default?.autoUpdater
    if (instance === undefined) {
      throw new Error('electron-updater did not expose autoUpdater.')
    }
    instance.autoDownload = false
    instance.autoInstallOnAppQuit = false
    instance.allowPrerelease = false
    instance.allowDowngrade = false
    instance.autoRunAppAfterInstall = true
    // The feed references a full setup.exe; web-installer semantics never
    // apply and electron-updater otherwise logs a warning on every download.
    instance.disableWebInstaller = true
    const base = options.feedBaseUrl?.trim()
    if (base !== undefined && base.length > 0) {
      // A trailing slash keeps a base path such as /updates/ when the
      // provider resolves `latest-linux.yml` against it.
      instance.setFeedURL({ provider: 'generic', url: `${base.replace(/\/+$/u, '')}/` })
    }
    instance.logger = logger
    // electron-updater is an EventEmitter: an unhandled 'error' event would
    // throw in the main process even when `download()` rejects normally.
    instance.on('error', (error: Error) => {
      logger.error('updater error:', error.message)
    })
    updater = instance
    return instance
  }

  return {
    async download(onProgress) {
      let autoUpdater: AutoUpdaterLike
      try {
        autoUpdater = await load()
      } catch (error) {
        throw downloadFailed(error instanceof Error ? error.message : String(error))
      }
      if (activeToken !== null) {
        throw downloadFailed('Another update download is already in progress.')
      }

      const token = new CancellationToken()
      activeToken = token
      const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
      const idleTimeoutMs = options.downloadIdleTimeoutMs ?? DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS
      let timer: ReturnType<typeof setTimeout> | null = null
      const arm = (ms: number): void => {
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => {
          logger.warn(`update request timed out after ${ms}ms`)
          token.cancel()
        }, ms)
      }
      const listener = (payload: DownloadProgressEvent): void => {
        // Progress proves the connection is alive; the idle timer restarts.
        arm(idleTimeoutMs)
        onProgress(toProgress(payload))
      }
      autoUpdater.on('download-progress', listener)
      try {
        arm(checkTimeoutMs)
        const result = await autoUpdater.checkForUpdates(token)
        const version = result?.updateInfo?.version
        if (typeof version !== 'string' || version.length === 0) {
          throw downloadFailed('The updater did not report an available version.')
        }
        logger.info(`downloading update ${version}`)
        arm(idleTimeoutMs)
        await autoUpdater.downloadUpdate(token)
        logger.info(`downloaded update ${version}`)
        return { version }
      } catch (error) {
        if (isAppError(error)) throw error
        const detail = token.cancelled
          ? 'The update request was cancelled or timed out.'
          : error instanceof Error
            ? error.message
            : String(error)
        throw downloadFailed(detail)
      } finally {
        if (timer !== null) clearTimeout(timer)
        autoUpdater.removeListener('download-progress', listener)
        if (activeToken === token) activeToken = null
      }
    },

    cancel() {
      activeToken?.cancel()
    },

    assertInstallable() {
      if (updater === null) {
        throw new Error('The update backend has no downloaded update.')
      }
      const path = updater.installerPath
      if (typeof path !== 'string' || path.length === 0) {
        throw new Error('The updater has no downloaded installer path.')
      }
      if (!fileExists(path)) {
        throw new Error(`The downloaded update installer is missing: ${path}`)
      }
      logger.info(`installer ready: ${path}`)
    },

    installerPath() {
      const path = updater?.installerPath
      return typeof path === 'string' && path.length > 0 ? path : null
    },

    quitAndInstall() {
      if (updater === null) {
        throw new Error('The update backend has no downloaded update.')
      }
      let failure: Error | null = null
      const onError: ErrorListener = (error) => {
        failure = error
      }
      updater.on('error', onError)
      try {
        // electron-updater dispatches missing-installer errors synchronously
        // and then returns without quitting; surface that before we lose the
        // only window that could explain it.
        updater.quitAndInstall(true, true)
      } finally {
        updater.removeListener('error', onError)
      }
      if (failure !== null) throw failure
    },

    dispose() {
      // The updater's own cache and downloaded installer must survive until
      // `quitAndInstall` runs. Only an in-flight download is cancelled.
      activeToken?.cancel()
      activeToken = null
    }
  }
}
