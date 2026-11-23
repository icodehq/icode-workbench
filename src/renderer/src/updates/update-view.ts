import type { MessageKey } from '../../../shared/i18n'
import type { UpdateState } from '../../../shared/schemas/updates'

/**
 * The banner's entire decision surface, kept out of React so it can be tested
 * without a DOM (the renderer test environment is node-only).
 */

export type UpdateBannerAction =
  | { kind: 'download'; labelKey: MessageKey }
  | { kind: 'open-download'; labelKey: MessageKey; url: string }
  | { kind: 'cancel-download'; labelKey: MessageKey }
  | { kind: 'restart'; labelKey: MessageKey }
  | { kind: 'retry'; labelKey: MessageKey }

export type UpdateBannerModel = {
  tone: 'info' | 'success' | 'error'
  titleKey: MessageKey
  titleParams: Record<string, string | number>
  action: UpdateBannerAction | null
  showSkip: boolean
  showLater: boolean
  progressPercent: number | null
}

export function updateBannerModel(
  state: UpdateState | null,
  dismissedVersion: string | null,
  platform: string | null
): UpdateBannerModel | null {
  if (state === null || state.mode === 'unsupported') return null

  if (state.phase === 'available') {
    if (state.availableVersion === null) return null
    if (dismissedVersion === state.availableVersion) return null
    const base: Omit<UpdateBannerModel, 'action'> = {
      tone: 'info',
      titleKey: 'updates.banner.available',
      titleParams: { version: state.availableVersion },
      showSkip: true,
      showLater: true,
      progressPercent: null
    }
    if (state.mode === 'install') {
      return { ...base, action: { kind: 'download', labelKey: 'updates.banner.download' } }
    }
    if (state.downloadUrl === null) return { ...base, action: null }
    if (platform === 'darwin') {
      return {
        ...base,
        action: {
          kind: 'open-download',
          labelKey: 'updates.banner.downloadMac',
          url: state.downloadUrl
        }
      }
    }
    return {
      ...base,
      action: {
        kind: 'open-download',
        labelKey: 'updates.banner.openDownloadPage',
        url: state.downloadUrl
      }
    }
  }

  if (state.phase === 'downloading') {
    return {
      tone: 'info',
      titleKey: 'updates.banner.downloading',
      titleParams: {},
      action: { kind: 'cancel-download', labelKey: 'common.cancel' },
      showSkip: false,
      showLater: false,
      progressPercent: state.progress?.percent ?? null
    }
  }

  if (state.phase === 'ready') {
    const version = state.availableVersion ?? state.currentVersion
    if (dismissedVersion === version) return null
    if (state.error !== null) {
      // A failed install returns to `ready` so it can be retried, but the
      // banner must not look like a clean success.
      return {
        tone: 'error',
        titleKey: 'updates.banner.failed',
        titleParams: {},
        action: { kind: 'restart', labelKey: 'updates.banner.restart' },
        showSkip: false,
        showLater: true,
        progressPercent: null
      }
    }
    return {
      tone: 'success',
      titleKey: 'updates.banner.ready',
      titleParams: { version },
      action: { kind: 'restart', labelKey: 'updates.banner.restart' },
      showSkip: false,
      showLater: true,
      progressPercent: null
    }
  }

  if (state.phase === 'restarting') {
    return {
      tone: 'info',
      titleKey: 'updates.banner.restarting',
      titleParams: {},
      action: null,
      showSkip: false,
      showLater: false,
      progressPercent: null
    }
  }

  if (state.phase === 'error') {
    return {
      tone: 'error',
      titleKey: 'updates.banner.failed',
      titleParams: {},
      action: { kind: 'retry', labelKey: 'common.retry' },
      showSkip: false,
      showLater: false,
      progressPercent: null
    }
  }

  return null
}
