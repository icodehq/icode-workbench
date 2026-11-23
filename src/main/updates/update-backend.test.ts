import { describe, expect, it, vi } from 'vitest'

/**
 * The packaged main bundle loads electron-updater with a dynamic import. The
 * module is CommonJS and defines `autoUpdater` with a getter, so Node's interop
 * exposes it on `default` rather than as a named export. This is the shape the
 * local AppImage E2E hit; keep a unit guard for it.
 */
const updater = vi.hoisted(() => ({
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowPrerelease: true,
  allowDowngrade: true,
  autoRunAppAfterInstall: false,
  logger: null as unknown,
  setFeedURL: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '0.18.0' } })),
  downloadUpdate: vi.fn(async () => []),
  quitAndInstall: vi.fn()
}))

// The named export exists but is undefined, matching the CJS interop shape;
// Vitest's module proxy otherwise throws for an export it does not know.
vi.mock('electron-updater', () => ({
  autoUpdater: undefined,
  default: { autoUpdater: updater }
}))

const { createUpdateBackend } = await import('./update-backend')

describe('update backend', () => {
  it('finds autoUpdater on the CommonJS default export and configures it', async () => {
    const backend = createUpdateBackend({ feedBaseUrl: 'http://127.0.0.1:9000/updates' })
    await expect(backend.download(vi.fn())).resolves.toEqual({ version: '0.18.0' })

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.autoRunAppAfterInstall).toBe(true)
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'http://127.0.0.1:9000/updates/'
    })
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(updater.on).toHaveBeenCalledWith('error', expect.any(Function))

    backend.quitAndInstall()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})
