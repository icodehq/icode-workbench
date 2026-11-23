import type { ReactNode } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import type { UpdateState } from '../../../shared/schemas/updates'
import SettingsCard from '../components/SettingsCard'
import { useT } from '../i18n/use-i18n'
import {
  cancelUpdateDownload,
  checkForUpdates,
  downloadUpdate,
  openUpdateDownload,
  requestUpdateInstall,
  setUpdateAutoCheck,
  skipUpdateVersion,
  useUpdateState
} from './updates-store'

type Props = {
  platform: string | null
}

function Row({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 text-[11.5px] last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right text-foreground">{children}</span>
    </div>
  )
}

function errorStatus(
  state: UpdateState,
  t: ReturnType<typeof useT>
): string {
  return state.error?.messageKey
    ? t(state.error.messageKey as MessageKey, state.error.messageParams)
    : (state.error?.message ?? t('settings.updates.notChecked'))
}

function statusText(state: UpdateState | null, t: ReturnType<typeof useT>): string {
  if (state === null) return t('settings.updates.notChecked')
  if (state.mode === 'unsupported') return t('settings.updates.unsupported')
  // Automatic check failures set `idle` so the banner stays quiet; Settings is
  // where every recorded error remains visible.
  if (state.error !== null) return errorStatus(state, t)
  switch (state.phase) {
    case 'checking':
      return t('settings.updates.checking')
    case 'up-to-date':
      return t('settings.updates.upToDate')
    case 'available':
      return t('settings.updates.available', { version: state.availableVersion ?? '' })
    case 'skipped':
      return t('settings.updates.skipped', { version: state.skippedVersion ?? '' })
    case 'downloading':
      return t('settings.updates.downloading', {
        percent: Math.round(state.progress?.percent ?? 0)
      })
    case 'ready':
      if (state.error !== null) return errorStatus(state, t)
      return t('settings.updates.ready', { version: state.availableVersion ?? '' })
    case 'restarting':
      return t('updates.banner.restarting')
    case 'error':
      return errorStatus(state, t)
    case 'idle':
    default:
      return t('settings.updates.notChecked')
  }
}

export default function UpdatesSettingsCard({ platform }: Props): React.JSX.Element {
  const t = useT()
  const state = useUpdateState()
  const busy =
    state?.phase === 'checking' ||
    state?.phase === 'downloading' ||
    state?.phase === 'restarting'
  // A ready update is a deliberate download result. The main-process check()
  // treats ready as busy, so offering "Check now" there is a silent no-op.
  const canCheck =
    state !== null && state.mode !== 'unsupported' && !busy && state.phase !== 'ready'
  const showDownload =
    state?.phase === 'available' && state.availableVersion !== null && state.mode === 'install'
  const showCancel = state?.phase === 'downloading'
  const showExternal =
    state?.phase === 'available' &&
    state.availableVersion !== null &&
    state.mode === 'notify' &&
    state.downloadUrl !== null
  const showRestart = state?.phase === 'ready'
  const showRetry = state?.phase === 'error'
  const showSkip = state?.phase === 'available'
  const showUnskip = state?.phase === 'skipped'

  return (
    <SettingsCard title={t('settings.updates.title')}>
      <div data-testid="settings-updates">
        <Row label={t('settings.updates.currentVersion')}>
          <span className="font-mono">v{state?.currentVersion ?? '—'}</span>
        </Row>
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {statusText(state, t)}
        </p>
        {state?.error?.detail !== undefined ? (
          <p className="mt-1 break-words text-[10px] leading-relaxed text-muted-foreground">
            {state.error.detail}
          </p>
        ) : null}

        {state !== null && state.mode !== 'unsupported' ? (
          <label className="mt-3 flex items-start gap-2 text-[11.5px]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={state.autoCheck}
              onChange={(event) => void setUpdateAutoCheck(event.target.checked)}
              data-testid="settings-updates-auto-check"
            />
            <span>
              <span className="block text-foreground">{t('settings.updates.autoCheck')}</span>
              <span className="block text-[10.5px] leading-relaxed text-muted-foreground">
                {t('settings.updates.autoCheckHelp')}
              </span>
            </span>
          </label>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[10.5px] hover:bg-muted disabled:opacity-40"
            disabled={!canCheck}
            onClick={() => void checkForUpdates()}
            data-testid="settings-updates-check"
          >
            {state?.phase === 'checking'
              ? t('settings.updates.checking')
              : t('settings.updates.checkNow')}
          </button>

          {showDownload ? (
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md bg-accent px-2 text-[10.5px] text-accent-ink hover:opacity-90"
              onClick={() => void downloadUpdate()}
              data-testid="settings-updates-download"
            >
              {t('updates.banner.download')}
            </button>
          ) : null}

          {showCancel ? (
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md border border-border px-2 text-[10.5px] hover:bg-muted"
              onClick={() => void cancelUpdateDownload()}
              data-testid="settings-updates-cancel"
            >
              {t('common.cancel')}
            </button>
          ) : null}

          {showExternal ? (
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md bg-accent px-2 text-[10.5px] text-accent-ink hover:opacity-90"
              onClick={() => openUpdateDownload(state.downloadUrl!)}
              data-testid="settings-updates-open-download"
            >
              {platform === 'darwin'
                ? t('updates.banner.downloadMac')
                : t('updates.banner.openDownloadPage')}
            </button>
          ) : null}

          {showRestart ? (
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md bg-accent px-2 text-[10.5px] text-accent-ink hover:opacity-90"
              onClick={() => void requestUpdateInstall()}
              data-testid="settings-updates-restart"
            >
              {t('updates.banner.restart')}
            </button>
          ) : null}

          {showRetry ? (
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md border border-border px-2 text-[10.5px] hover:bg-muted"
              onClick={() => void checkForUpdates()}
            >
              {t('common.retry')}
            </button>
          ) : null}

          {showSkip ? (
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md px-2 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void skipUpdateVersion(state.availableVersion)}
              data-testid="settings-updates-skip"
            >
              {t('settings.updates.skip')}
            </button>
          ) : null}

          {showUnskip ? (
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md px-2 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void skipUpdateVersion(null)}
              data-testid="settings-updates-unskip"
            >
              {t('settings.updates.showSkipped')}
            </button>
          ) : null}

          {state?.releaseUrl !== null && state?.releaseUrl !== undefined ? (
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md px-2 text-[10.5px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
              onClick={() => openUpdateDownload(state.releaseUrl!)}
            >
              {t('settings.updates.releaseNotes')}
            </button>
          ) : null}
        </div>

        {state?.mode === 'notify' && platform === 'darwin' ? (
          <p className="mt-3 text-[10.5px] leading-relaxed text-muted-foreground">
            {t('settings.updates.macHelp')}
          </p>
        ) : null}
        {state?.mode === 'notify' && platform === 'linux' ? (
          <p className="mt-3 text-[10.5px] leading-relaxed text-muted-foreground">
            {t('settings.updates.packageHelp')}
          </p>
        ) : null}
      </div>
    </SettingsCard>
  )
}
