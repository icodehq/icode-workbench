import { describe, expect, it } from 'vitest'
import type { UpdateState } from '../../../shared/schemas/updates'
import { updateBannerModel } from './update-view'

function state(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    mode: 'install',
    phase: 'idle',
    currentVersion: '0.17.0',
    availableVersion: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    autoCheck: true,
    skippedVersion: null,
    checkedAt: null,
    error: null,
    unsupportedReason: null,
    ...overrides
  }
}

describe('update banner model', () => {
  it('stays hidden for quiet phases and unsupported builds', () => {
    for (const phase of ['idle', 'checking', 'up-to-date', 'skipped'] as const) {
      expect(updateBannerModel(state({ phase }), null, 'win32')).toBeNull()
    }
    expect(
      updateBannerModel(
        state({ mode: 'unsupported', unsupportedReason: 'not-packaged' }),
        null,
        'win32'
      )
    ).toBeNull()
    expect(updateBannerModel(null, null, 'win32')).toBeNull()
  })

  it('offers an in-app download for install mode', () => {
    const model = updateBannerModel(
      state({ phase: 'available', availableVersion: '0.18.0' }),
      null,
      'win32'
    )
    expect(model).toMatchObject({
      tone: 'info',
      titleKey: 'updates.banner.available',
      titleParams: { version: '0.18.0' },
      action: { kind: 'download', labelKey: 'updates.banner.download' },
      showSkip: true,
      showLater: true
    })
  })

  it('links to the arch-matched dmg on macOS and the release page elsewhere', () => {
    const mac = updateBannerModel(
      state({
        mode: 'notify',
        phase: 'available',
        availableVersion: '0.18.0',
        downloadUrl: 'https://example.com/iCode-0.18.0-mac-arm64.dmg'
      }),
      null,
      'darwin'
    )
    expect(mac?.action).toEqual({
      kind: 'open-download',
      labelKey: 'updates.banner.downloadMac',
      url: 'https://example.com/iCode-0.18.0-mac-arm64.dmg'
    })

    const linux = updateBannerModel(
      state({
        mode: 'notify',
        phase: 'available',
        availableVersion: '0.18.0',
        downloadUrl: 'https://example.com/releases/v0.18.0'
      }),
      null,
      'linux'
    )
    expect(linux?.action).toEqual({
      kind: 'open-download',
      labelKey: 'updates.banner.openDownloadPage',
      url: 'https://example.com/releases/v0.18.0'
    })
  })

  it('hides an available version the user dismissed', () => {
    const available = state({ phase: 'available', availableVersion: '0.18.0' })
    expect(updateBannerModel(available, '0.18.0', 'win32')).toBeNull()
    expect(updateBannerModel(available, '0.17.9', 'win32')).not.toBeNull()
  })

  it('shows throttled progress while downloading', () => {
    const model = updateBannerModel(
      state({
        phase: 'downloading',
        availableVersion: '0.18.0',
        progress: { percent: 42.4, transferred: 1, total: 2, bytesPerSecond: 3 }
      }),
      null,
      'win32'
    )
    expect(model).toMatchObject({
      titleKey: 'updates.banner.downloading',
      progressPercent: 42.4,
      action: null,
      showSkip: false,
      showLater: false
    })
  })

  it('asks for a restart once the update is ready and respects dismissal', () => {
    const ready = state({ phase: 'ready', availableVersion: '0.18.0' })
    expect(updateBannerModel(ready, null, 'win32')).toMatchObject({
      tone: 'success',
      action: { kind: 'restart', labelKey: 'updates.banner.restart' }
    })
    expect(updateBannerModel(ready, '0.18.0', 'win32')).toBeNull()

    const failed = state({
      phase: 'ready',
      availableVersion: '0.18.0',
      error: {
        code: 'UPDATE_INSTALL_FAILED',
        message: 'Could not install the update.',
        retryable: true
      }
    })
    expect(updateBannerModel(failed, null, 'win32')).toMatchObject({
      tone: 'error',
      titleKey: 'updates.banner.failed',
      action: { kind: 'restart' }
    })
  })

  it('reports restarting and failed states without extra actions', () => {
    expect(
      updateBannerModel(state({ phase: 'restarting', availableVersion: '0.18.0' }), null, 'win32')
    ).toMatchObject({ titleKey: 'updates.banner.restarting', action: null })

    expect(
      updateBannerModel(
        state({
          phase: 'error',
          availableVersion: '0.18.0',
          error: {
            code: 'UPDATE_DOWNLOAD_FAILED',
            message: 'Could not download.',
            retryable: true
          }
        }),
        null,
        'win32'
      )
    ).toMatchObject({
      tone: 'error',
      titleKey: 'updates.banner.failed',
      action: { kind: 'retry', labelKey: 'common.retry' }
    })
  })

  it('has no action when a notify build lacks a download URL', () => {
    const model = updateBannerModel(
      state({ mode: 'notify', phase: 'available', availableVersion: '0.18.0' }),
      null,
      'darwin'
    )
    expect(model).toMatchObject({ action: null, showSkip: true, showLater: true })
  })
})
