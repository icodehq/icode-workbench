import { useCallback, useEffect, useState } from 'react'
import type { OpenCodeIntegrationStatePayload } from '../../../shared/schemas/opencode-integration'
import { callApi } from '../lib/api'
import { useT } from '../i18n/use-i18n'
import SettingsCard from './SettingsCard'

function stateLabel(
  state: OpenCodeIntegrationStatePayload,
  t: ReturnType<typeof useT>
): string {
  switch (state.install.state) {
    case 'installed':
      return t('settings.opencode.installed', { api: state.install.api })
    case 'not-installed':
      return t('settings.opencode.notInstalled')
    case 'unsupported':
      return t('settings.opencode.unsupported')
    case 'failed':
      return t('settings.opencode.failed')
  }
}

/**
 * Default-on managed OpenCode status. The card reports exactly which config
 * directory was touched and never claims activity when installation failed.
 */
export default function OpencodeSettingsCard(): React.JSX.Element {
  const t = useT()
  const [state, setState] = useState<OpenCodeIntegrationStatePayload | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const result = await callApi(window.icode.opencodeIntegration.get())
    if (result.ok) setState(result.value)
    else setError(result.error.message)
  }, [])

  useEffect(() => {
    void reload()
    const unsubscribe = window.icode.opencodeIntegration.onChanged((next) => {
      setState(next)
      setError(null)
    })
    return unsubscribe
  }, [reload])

  const toggle = async (enabled: boolean): Promise<void> => {
    setSaving(true)
    setError(null)
    const result = await callApi(window.icode.opencodeIntegration.setEnabled({ enabled }))
    if (result.ok) setState(result.value)
    else setError(result.error.message)
    setSaving(false)
  }

  const detail = state?.install
  return (
    <SettingsCard title={t('settings.opencode.title')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            {t('settings.opencode.description')}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[11.5px]">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--color-accent)]"
            checked={state?.enabled ?? true}
            disabled={saving || state === null}
            onChange={(event) => void toggle(event.target.checked)}
            data-testid="settings-opencode-enabled"
          />
          {t('settings.opencode.enabled')}
        </label>
      </div>

      <div className="mt-3 border-t border-line pt-3 text-[10.5px] leading-relaxed text-muted-foreground">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{t('settings.opencode.state')}</span>
          <span className="text-foreground">
            {state === null ? '—' : stateLabel(state, t)}
          </span>
        </div>
        {detail?.configDir ? (
          <div className="mt-1 break-all font-mono text-[10px]">
            {t('settings.opencode.configDir', { dir: detail.configDir })}
          </div>
        ) : null}
        {detail?.state === 'installed' && detail.tuiRegistered ? (
          <div className="mt-1">{t('settings.opencode.tuiRegistered')}</div>
        ) : null}
        {detail?.state === 'failed' || detail?.state === 'unsupported' ? (
          <div className="mt-1 text-signal">{detail.detail}</div>
        ) : null}
        <p className="mt-2">{t('settings.opencode.enabledHelp')}</p>
        <p className="mt-1">{t('settings.opencode.restartHint')}</p>
        {error !== null ? (
          <p className="mt-2 text-signal" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsCard>
  )
}
