import { makeAppError, type AppError } from '../../shared/domain/errors'
import type { UpdateProgress } from '../../shared/schemas/updates'

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

type AutoUpdaterLike = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  autoRunAppAfterInstall: boolean
  logger: unknown
  setFeedURL(options: unknown): void
  on(event: 'download-progress', listener: (payload: DownloadProgressEvent) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  removeListener(
    event: 'download-progress',
    listener: (payload: DownloadProgressEvent) => void
  ): void
  checkForUpdates(): Promise<UpdateCheckResultLike | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export type UpdateBackend = {
  /** Re-checks the feed (electron-updater is authoritative) and downloads. */
  download(onProgress: (progress: UpdateProgress) => void): Promise<{ version: string }>
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
}

export function createUpdateBackend(options: UpdateBackendOptions = {}): UpdateBackend {
  let updater: AutoUpdaterLike | null = null

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
    const base = options.feedBaseUrl?.trim()
    if (base !== undefined && base.length > 0) {
      // A trailing slash keeps a base path such as /updates/ when the
      // provider resolves `latest-linux.yml` against it.
      instance.setFeedURL({ provider: 'generic', url: `${base.replace(/\/+$/u, '')}/` })
    }
    instance.logger = {
      info: (...args: unknown[]) => console.info('[updates]', ...args),
      warn: (...args: unknown[]) => console.warn('[updates]', ...args),
      error: (...args: unknown[]) => console.error('[updates]', ...args),
      debug: (...args: unknown[]) => console.debug('[updates]', ...args)
    }
    // electron-updater is an EventEmitter: an unhandled 'error' event would
    // throw in the main process even when `download()` rejects normally.
    instance.on('error', (error: Error) => {
      console.error('[updates] updater error:', error.message)
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

      const listener = (payload: DownloadProgressEvent): void => onProgress(toProgress(payload))
      autoUpdater.on('download-progress', listener)
      try {
        const result = await autoUpdater.checkForUpdates()
        const version = result?.updateInfo?.version
        if (typeof version !== 'string' || version.length === 0) {
          throw downloadFailed('The updater did not report an available version.')
        }
        await autoUpdater.downloadUpdate()
        return { version }
      } catch (error) {
        if (isAppError(error)) throw error
        throw downloadFailed(error instanceof Error ? error.message : String(error))
      } finally {
        autoUpdater.removeListener('download-progress', listener)
      }
    },

    quitAndInstall() {
      if (updater === null) {
        throw new Error('The update backend has no downloaded update.')
      }
      updater.quitAndInstall(true, true)
    },

    dispose() {
      // Nothing to release: the updater's own cache and downloaded installer
      // must survive until `quitAndInstall` runs.
    }
  }
}
