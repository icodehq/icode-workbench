import { AlertTriangle, Download, RotateCcw } from 'lucide-react'
import type { MessageKey } from '../../../shared/i18n'
import { useT } from '../i18n/use-i18n'
import { updateBannerModel } from './update-view'
import {
  checkForUpdates,
  dismissUpdate,
  downloadUpdate,
  openUpdateDownload,
  requestUpdateInstall,
  skipUpdateVersion,
  useDismissedUpdateVersion,
  useUpdateState
} from './updates-store'

type Props = {
  platform: string | null
}

const TONE_CLASSES = {
  info: 'border-signal-line bg-signal-weak text-signal',
  success: 'border-add/40 bg-add-weak text-add',
  error: 'border-destructive/40 bg-destructive/12 text-destructive'
} as const

export default function UpdateBanner({ platform }: Props): React.JSX.Element | null {
  const t = useT()
  const state = useUpdateState()
  const dismissedVersion = useDismissedUpdateVersion()
  const model = updateBannerModel(state, dismissedVersion, platform)

  if (model === null || state === null) return null

  const version = state.availableVersion
  const errorText =
    state.error === null
      ? null
      : state.error.messageKey
        ? t(state.error.messageKey as MessageKey, state.error.messageParams)
        : state.error.message

  const runAction = (): void => {
    if (model.action === null) return
    switch (model.action.kind) {
      case 'download':
        void downloadUpdate()
        return
      case 'open-download':
        openUpdateDownload(model.action.url)
        return
      case 'restart':
        void requestUpdateInstall()
        return
      case 'retry':
        void checkForUpdates()
    }
  }

  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-[10.5px] ${TONE_CLASSES[model.tone]}`}
      role="status"
      aria-live="polite"
      data-testid="update-banner"
      data-phase={state.phase}
    >
      {model.tone === 'error' ? (
        <AlertTriangle size={11} className="shrink-0" />
      ) : model.tone === 'success' ? (
        <RotateCcw size={11} className="shrink-0" />
      ) : (
        <Download size={11} className="shrink-0" />
      )}

      <span className="min-w-0 flex-1 truncate" title={errorText ?? undefined}>
        {t(model.titleKey, model.titleParams)}
        {model.tone === 'error' && errorText !== null ? ` — ${errorText}` : ''}
      </span>

      {model.progressPercent !== null ? (
        <span
          className="h-1 w-24 overflow-hidden rounded bg-black/10"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(model.progressPercent)}
        >
          <span
            className="block h-full bg-current transition-[width]"
            style={{ width: `${model.progressPercent}%` }}
          />
        </span>
      ) : null}

      {model.action !== null ? (
        <button
          type="button"
          className="inline-flex h-6 shrink-0 items-center rounded border border-current px-2 text-[10px] opacity-90 hover:bg-black/5 hover:opacity-100"
          onClick={runAction}
          data-testid="update-banner-action"
        >
          {t(model.action.labelKey)}
        </button>
      ) : null}

      {model.showLater ? (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] opacity-80 hover:bg-black/5 hover:opacity-100"
          onClick={() => dismissUpdate(version)}
          data-testid="update-banner-later"
        >
          {t('updates.banner.later')}
        </button>
      ) : null}

      {model.showSkip ? (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] opacity-80 hover:bg-black/5 hover:opacity-100"
          onClick={() => void skipUpdateVersion(version)}
          data-testid="update-banner-skip"
        >
          {t('updates.banner.skip')}
        </button>
      ) : null}

      {state.releaseUrl !== null && model.tone !== 'error' ? (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] underline underline-offset-2 opacity-80 hover:opacity-100"
          onClick={() => openUpdateDownload(state.releaseUrl!)}
          data-testid="update-banner-release-notes"
        >
          {t('updates.banner.viewRelease')}
        </button>
      ) : null}
    </div>
  )
}
