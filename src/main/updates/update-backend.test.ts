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
  disableWebInstaller: false,
  installerPath: '/tmp/icode-setup.exe' as string | null,
  logger: null as unknown,
  setFeedURL: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  checkForUpdates: vi.fn(async (_token?: unknown) => ({ updateInfo: { version: '0.18.0' } })),
  downloadUpdate: vi.fn(async (_token?: unknown) => []),
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
    expect(updater.disableWebInstaller).toBe(true)
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

  it('accepts an existing downloaded installer and reports its path', async () => {
    updater.installerPath = '/tmp/icode-setup.exe'
    const checked: string[] = []
    const backend = createUpdateBackend({
      fileExists: (path) => {
        checked.push(path)
        return true
      }
    })
    await backend.download(vi.fn())
    expect(() => backend.assertInstallable()).not.toThrow()
    expect(backend.installerPath()).toBe('/tmp/icode-setup.exe')
    expect(checked).toContain('/tmp/icode-setup.exe')
  })

  it('refuses to install when the downloaded installer is missing', async () => {
    updater.installerPath = '/tmp/icode-setup.exe'
    const backend = createUpdateBackend({ fileExists: () => false })
    await backend.download(vi.fn())
    expect(() => backend.assertInstallable()).toThrow(/missing/)
    expect(backend.installerPath()).toBe('/tmp/icode-setup.exe')
    updater.installerPath = null
    expect(backend.installerPath()).toBeNull()
  })

  it('cancels an in-flight check with the cancellation token', async () => {
    updater.installerPath = '/tmp/icode-setup.exe'
    const backend = createUpdateBackend({})
    let token: { cancelled: boolean; onCancel(callback: () => void): void } | null = null
    updater.checkForUpdates.mockImplementationOnce(
      (requestToken: unknown) =>
        new Promise((_resolve, reject) => {
          const typed = requestToken as {
            cancelled: boolean
            onCancel(callback: () => void): void
          }
          token = typed
          typed.onCancel(() => reject(new Error('cancelled')))
        })
    )

    const pending = backend.download(vi.fn())
    for (let index = 0; index < 50 && token === null; index += 1) {
      await Promise.resolve()
    }
    expect(token).not.toBeNull()
    backend.cancel()
    await expect(pending).rejects.toMatchObject({ code: 'UPDATE_DOWNLOAD_FAILED' })
    expect(token!.cancelled).toBe(true)
  })
})
