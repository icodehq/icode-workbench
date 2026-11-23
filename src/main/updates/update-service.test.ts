import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFERENCES, type AppPreferences } from '../app/preferences'
import { makeAppError } from '../../shared/domain/errors'
import type { UpdateLiveSession } from '../../shared/schemas/updates'
import {
  createUpdateService,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  type UpdateServiceDeps
} from './update-service'
import type { ReleaseFeed } from './release-feed'
import type { UpdateBackend } from './update-backend'

type Harness = {
  service: ReturnType<typeof createUpdateService>
  feed: { check: ReturnType<typeof vi.fn> }
  backend: {
    download: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    assertInstallable: ReturnType<typeof vi.fn>
    installerPath: ReturnType<typeof vi.fn>
    quitAndInstall: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }
  sessions: {
    listLive: ReturnType<typeof vi.fn>
    sleepAllLive: ReturnType<typeof vi.fn>
  }
  windows: {
    prepareForClose: ReturnType<typeof vi.fn>
    beginInstall: ReturnType<typeof vi.fn>
  }
  background: {
    quiesce: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
  }
  stopTerminalHosts: ReturnType<typeof vi.fn>
  shutdownRuntime: ReturnType<typeof vi.fn>
  relaunchAfterFailure: ReturnType<typeof vi.fn>
  preferences: () => AppPreferences
}

function harness(
  options: {
    overrides?: Partial<UpdateServiceDeps>
    platform?: string
    packaged?: boolean
    appImage?: string | null
    live?: UpdateLiveSession[]
  } = {}
): Harness {
  let preferences: AppPreferences = { ...DEFAULT_APP_PREFERENCES }
  const feed = { check: vi.fn(async () => ({ status: 'up-to-date', checkedAt: 1_000 })) }
  const backend = {
    download: vi.fn(async (onProgress: (progress: unknown) => void) => {
      onProgress({ percent: 50, transferred: 10, total: 20, bytesPerSecond: 5 })
      return { version: '0.18.0' }
    }),
    cancel: vi.fn(),
    assertInstallable: vi.fn(),
    installerPath: vi.fn(() => '/tmp/icode-setup.exe'),
    quitAndInstall: vi.fn(),
    dispose: vi.fn()
  }
  const sessions = {
    listLive: vi.fn(async () => options.live ?? []),
    sleepAllLive: vi.fn(async () => ({ slept: options.live?.length ?? 0, failed: 0 }))
  }
  const windows = {
    prepareForClose: vi.fn(async () => 'ready' as const),
    beginInstall: vi.fn()
  }
  const background = { quiesce: vi.fn(), resume: vi.fn() }
  const stopTerminalHosts = vi.fn(async () => undefined)
  const shutdownRuntime = vi.fn(async () => undefined)
  const relaunchAfterFailure = vi.fn()

  const deps: UpdateServiceDeps = {
    currentVersion: '0.17.0',
    packaged: options.packaged ?? true,
    platform: options.platform ?? 'win32',
    arch: 'x64',
    appImage: options.appImage ?? null,
    feed: feed as unknown as ReleaseFeed,
    backend: backend as unknown as UpdateBackend,
    preferences: {
      load: () => preferences,
      update: (patch) => {
        preferences = { ...preferences, ...patch }
        return true
      }
    },
    sessions,
    windows,
    background,
    stopTerminalHosts,
    shutdownRuntime,
    relaunchAfterFailure,
    now: () => 1_000,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...options.overrides
  }

  return {
    service: createUpdateService(deps),
    feed,
    backend,
    sessions,
    windows,
    background,
    stopTerminalHosts,
    shutdownRuntime,
    relaunchAfterFailure,
    preferences: () => preferences
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function available(version = '0.18.0') {
  return {
    status: 'available' as const,
    checkedAt: 1_000,
    version,
    releaseUrl: `https://github.com/icodehq/icode-workbench/releases/tag/v${version}`,
    downloadUrl: null
  }
}

async function ready(h: Harness): Promise<void> {
  h.feed.check.mockResolvedValueOnce(available())
  await h.service.check()
  await h.service.download()
  expect(h.service.getState().phase).toBe('ready')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('update service', () => {
  it('is unsupported in development', () => {
    vi.useFakeTimers()
    const h = harness({ packaged: false })
    expect(h.service.getState()).toMatchObject({
      mode: 'unsupported',
      phase: 'idle',
      unsupportedReason: 'not-packaged'
    })
    h.service.start()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks after the startup delay and on the interval', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.service.start()
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY_MS)
    expect(h.feed.check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(h.feed.check).toHaveBeenCalledTimes(2)
    h.service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors the auto-check preference and still checks manually', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.service.setAutoCheck(false)
    h.service.start()
    expect(vi.getTimerCount()).toBe(0)
    await h.service.check()
    expect(h.feed.check).toHaveBeenCalledTimes(1)
    expect(h.service.getState().phase).toBe('up-to-date')
  })

  it('publishes an available version and persists a skip', async () => {
    const h = harness()
    h.feed.check.mockResolvedValueOnce(available())
    await h.service.check()
    expect(h.service.getState()).toMatchObject({
      phase: 'available',
      availableVersion: '0.18.0',
      downloadUrl: null
    })

    const skipped = h.service.skip('0.18.0')
    expect(skipped.phase).toBe('skipped')
    expect(h.preferences().skippedUpdateVersion).toBe('0.18.0')

    h.feed.check.mockResolvedValueOnce(available('0.18.0'))
    await h.service.check()
    // A manual check deliberately reveals a skipped version again.
    expect(h.service.getState().phase).toBe('available')

    h.service.skip('0.18.0')
    h.feed.check.mockResolvedValueOnce(available('0.19.0'))
    await h.service.check()
    expect(h.service.getState()).toMatchObject({
      phase: 'available',
      availableVersion: '0.19.0'
    })

    h.service.skip('0.19.0')
    const cleared = h.service.skip(null)
    expect(cleared.phase).toBe('available')
    expect(h.preferences().skippedUpdateVersion).toBeNull()
  })

  it('re-runs a manual check that arrives during an automatic check', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.service.skip('0.18.0')
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => {
      release = resolve
    })
    h.feed.check.mockImplementationOnce(() => gate).mockResolvedValueOnce(available())

    h.service.start()
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY_MS)
    const manual = h.service.check()
    release(available())
    const state = await manual

    expect(h.feed.check).toHaveBeenCalledTimes(2)
    // The automatic pass respected the skip; the manual pass revealed it.
    expect(state.phase).toBe('available')
    h.service.dispose()
  })

  it('suppresses a skipped version during an automatic check', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.service.skip('0.18.0')
    h.feed.check.mockResolvedValue(available('0.18.0'))
    h.service.start()
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY_MS)
    await flush()
    expect(h.service.getState()).toMatchObject({
      phase: 'skipped',
      availableVersion: '0.18.0'
    })
    h.service.dispose()
  })

  it('requires an explicit download and reports progress', async () => {
    const h = harness()
    h.feed.check.mockResolvedValueOnce(available())
    await h.service.check()
    expect(h.backend.download).not.toHaveBeenCalled()

    await h.service.download()
    expect(h.backend.download).toHaveBeenCalledTimes(1)
    expect(h.service.getState()).toMatchObject({
      phase: 'ready',
      availableVersion: '0.18.0'
    })
  })

  it('keeps the available version after a failed download', async () => {
    const h = harness()
    h.feed.check.mockResolvedValueOnce(available())
    await h.service.check()
    h.backend.download.mockRejectedValueOnce(new Error('offline'))
    await h.service.download()
    expect(h.service.getState()).toMatchObject({
      phase: 'error',
      availableVersion: '0.18.0',
      error: { code: 'UPDATE_DOWNLOAD_FAILED' }
    })

    await h.service.download()
    expect(h.service.getState().phase).toBe('ready')
  })

  it('returns to available when the user cancels a download', async () => {
    const h = harness()
    h.feed.check.mockResolvedValueOnce(available())
    await h.service.check()
    let rejectDownload: (error: Error) => void = () => undefined
    h.backend.download.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDownload = reject
        })
    )

    const pending = h.service.download()
    await flush()
    h.service.cancelDownload()
    expect(h.backend.cancel).toHaveBeenCalledTimes(1)
    rejectDownload(new Error('cancelled'))
    await pending
    expect(h.service.getState()).toMatchObject({
      phase: 'available',
      availableVersion: '0.18.0',
      error: null
    })
  })

  it('reports an interrupted install from the journal', () => {
    const h = harness({
      overrides: {
        interruptedInstall: {
          version: 1,
          fromVersion: '0.17.0',
          toVersion: '0.18.0',
          startedAt: 500,
          installerPath: '/tmp/iCode-setup.exe'
        }
      }
    })
    expect(h.service.getState()).toMatchObject({
      mode: 'install',
      phase: 'error',
      availableVersion: '0.18.0',
      error: { code: 'UPDATE_INSTALL_FAILED' }
    })
    expect(h.service.getState().error?.detail).toContain('0.18.0')
  })

  it('keeps automatic check failures out of the banner but records them', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.feed.check.mockRejectedValue(new Error('offline'))
    h.service.start()
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY_MS)
    await flush()
    expect(h.service.getState()).toMatchObject({
      phase: 'idle',
      error: { code: 'UPDATE_CHECK_FAILED' }
    })
    h.service.dispose()
  })

  it('surfaces a manual check failure', async () => {
    const h = harness()
    h.feed.check.mockRejectedValueOnce(new Error('offline'))
    await h.service.check()
    expect(h.service.getState()).toMatchObject({
      phase: 'error',
      error: { code: 'UPDATE_CHECK_FAILED' }
    })
  })

  it('returns a typed block for unsupported and not-ready installs', async () => {
    const notify = harness({ platform: 'darwin' })
    notify.feed.check.mockResolvedValueOnce({
      ...available(),
      downloadUrl: 'https://example.com/iCode.dmg'
    })
    await notify.service.check()
    await expect(notify.service.install({})).resolves.toMatchObject({
      status: 'blocked',
      error: { code: 'UPDATE_NOT_SUPPORTED' }
    })

    const h = harness()
    await expect(h.service.install({})).resolves.toMatchObject({
      status: 'blocked',
      error: { code: 'UPDATE_NOT_READY' }
    })
  })

  it('blocks install when the platform cannot replace the app', async () => {
    const error = makeAppError('UPDATE_INSTALL_FAILED', 'read only')
    const h = harness({ overrides: { preflightInstall: () => error } })
    await ready(h)
    await expect(h.service.install({})).resolves.toEqual({ status: 'blocked', error })
    expect(h.windows.prepareForClose).not.toHaveBeenCalled()
    expect(h.stopTerminalHosts).not.toHaveBeenCalled()
  })

  it('blocks install when the downloaded installer is missing', async () => {
    const h = harness()
    await ready(h)
    h.backend.assertInstallable.mockImplementationOnce(() => {
      throw new Error('installer missing')
    })
    await expect(h.service.install({})).resolves.toMatchObject({
      status: 'blocked',
      error: { code: 'UPDATE_INSTALL_FAILED', detail: 'installer missing' }
    })
    expect(h.windows.prepareForClose).not.toHaveBeenCalled()
  })

  it('serializes concurrent install requests from one ready state', async () => {
    vi.useFakeTimers()
    const h = harness()
    await ready(h)
    const [first, second] = await Promise.all([
      h.service.install({ stopLiveSessions: true }),
      h.service.install({ stopLiveSessions: true })
    ])
    expect([first.status, second.status].sort()).toEqual(['blocked', 'restarting'])

    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(h.windows.prepareForClose).toHaveBeenCalledTimes(1)
    expect(h.backend.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('records the install attempt before running the installer', async () => {
    vi.useFakeTimers()
    const journal = { begin: vi.fn() }
    const h = harness({ overrides: { journal } })
    await ready(h)
    await h.service.install({})
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(journal.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        fromVersion: '0.17.0',
        toVersion: '0.18.0',
        installerPath: '/tmp/icode-setup.exe'
      })
    )
  })

  it('asks for confirmation before sleeping live sessions', async () => {
    const live = [{ id: 'ses_1', title: 'Agent one' }]
    const h = harness({ live })
    await ready(h)
    await expect(h.service.install({})).resolves.toEqual({
      status: 'confirmation-required',
      version: '0.18.0',
      liveSessions: live
    })
    expect(h.service.getState().phase).toBe('ready')
  })

  it('saves, quiesces, sleeps, stops hosts, shuts down and installs in order', async () => {
    vi.useFakeTimers()
    const live = [{ id: 'ses_1', title: 'Agent one' }]
    const h = harness({ live })
    await ready(h)
    await expect(h.service.install({ stopLiveSessions: true })).resolves.toEqual({
      status: 'restarting'
    })
    expect(h.service.getState().phase).toBe('restarting')

    await vi.advanceTimersByTimeAsync(300)
    await flush()

    expect(h.windows.prepareForClose).toHaveBeenCalledTimes(1)
    expect(h.background.quiesce).toHaveBeenCalledTimes(1)
    expect(h.sessions.sleepAllLive).toHaveBeenCalledTimes(1)
    expect(h.stopTerminalHosts).toHaveBeenCalledTimes(1)
    expect(h.shutdownRuntime).toHaveBeenCalledTimes(1)
    expect(h.windows.beginInstall).toHaveBeenCalledTimes(1)
    expect(h.backend.quitAndInstall).toHaveBeenCalledTimes(1)

    const order = [
      h.windows.prepareForClose.mock.invocationCallOrder[0],
      h.background.quiesce.mock.invocationCallOrder[0],
      h.sessions.sleepAllLive.mock.invocationCallOrder[0],
      h.stopTerminalHosts.mock.invocationCallOrder[0],
      h.shutdownRuntime.mock.invocationCallOrder[0],
      h.windows.beginInstall.mock.invocationCallOrder[0],
      h.backend.quitAndInstall.mock.invocationCallOrder[0]
    ] as number[]
    expect([...order].sort((left, right) => left - right)).toEqual(order)
  })

  it('cancels a queued install when the app is disposed first', async () => {
    vi.useFakeTimers()
    const h = harness()
    await ready(h)
    await h.service.install({})
    h.service.dispose()
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(h.windows.prepareForClose).not.toHaveBeenCalled()
    expect(h.stopTerminalHosts).not.toHaveBeenCalled()
  })

  it('returns to ready when the save prompt is cancelled', async () => {
    vi.useFakeTimers()
    const h = harness()
    await ready(h)
    h.windows.prepareForClose.mockResolvedValueOnce('cancelled')
    await h.service.install({})
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(h.service.getState().phase).toBe('ready')
    expect(h.background.quiesce).not.toHaveBeenCalled()
    expect(h.stopTerminalHosts).not.toHaveBeenCalled()
  })

  it('aborts before stopping hosts when a session cannot be slept', async () => {
    vi.useFakeTimers()
    const h = harness({ live: [{ id: 'ses_1', title: 'Agent one' }] })
    await ready(h)
    h.sessions.sleepAllLive.mockResolvedValueOnce({
      slept: 0,
      failed: 1,
      detail: '1 of 1 live session(s) could not be slept: Agent one (ses_1)'
    })
    await h.service.install({ stopLiveSessions: true })
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(h.sessions.sleepAllLive).toHaveBeenCalledTimes(1)
    expect(h.stopTerminalHosts).not.toHaveBeenCalled()
    expect(h.background.resume).toHaveBeenCalledTimes(1)
    expect(h.service.getState()).toMatchObject({
      phase: 'ready',
      error: {
        code: 'UPDATE_INSTALL_FAILED',
        detail: expect.stringContaining('Agent one')
      }
    })
  })

  it('aborts and resumes background work when host shutdown fails', async () => {
    vi.useFakeTimers()
    const h = harness()
    await ready(h)
    h.stopTerminalHosts.mockRejectedValueOnce(
      makeAppError('UPDATE_INSTALL_FAILED', 'host busy')
    )
    await h.service.install({})
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(h.background.resume).toHaveBeenCalledTimes(1)
    expect(h.shutdownRuntime).not.toHaveBeenCalled()
    expect(h.service.getState()).toMatchObject({
      phase: 'ready',
      error: { code: 'UPDATE_INSTALL_FAILED' }
    })
  })

  it('relaunches when teardown fails after the runtime is shut down', async () => {
    vi.useFakeTimers()
    const h = harness()
    await ready(h)
    h.shutdownRuntime.mockRejectedValueOnce(new Error('boom'))
    await h.service.install({})
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(h.relaunchAfterFailure).toHaveBeenCalledTimes(1)
  })

  it('does not install new sessions that appear without consent', async () => {
    vi.useFakeTimers()
    const h = harness()
    await ready(h)
    // The first list (inside install) is empty; a session appears before teardown.
    h.sessions.listLive
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'ses_new', title: 'New agent' }])
    await h.service.install({})
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(h.sessions.sleepAllLive).not.toHaveBeenCalled()
    expect(h.stopTerminalHosts).not.toHaveBeenCalled()
    expect(h.background.resume).toHaveBeenCalledTimes(1)
    expect(h.service.getState()).toMatchObject({
      phase: 'ready',
      error: { code: 'UPDATE_INSTALL_FAILED' }
    })
  })

  it('disposes timers, listeners and the backend', async () => {
    vi.useFakeTimers()
    const h = harness()
    const listener = vi.fn()
    h.service.subscribe(listener)
    h.service.start()
    expect(vi.getTimerCount()).toBe(2)
    h.service.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(h.backend.dispose).toHaveBeenCalledTimes(1)
    h.service.setAutoCheck(true)
    expect(listener).not.toHaveBeenCalled()
  })
})
