import { useCallback, useEffect, useState } from 'react'
import type {
  ManagedHookProviderStatusPayload,
  ManagedHooksStatePayload
} from '../../../shared/schemas/managed-hooks'
import { callApi } from '../lib/api'
import { useT } from '../i18n/use-i18n'
import SettingsCard from './SettingsCard'

function stateLabel(
  state: ManagedHookProviderStatusPayload['state'],
  t: ReturnType<typeof useT>
): string {
  switch (state) {
    case 'installed':
      return t('settings.managedHooks.state.installed')
    case 'partial':
      return t('settings.managedHooks.state.partial')
    case 'not-installed':
      return t('settings.managedHooks.state.notInstalled')
    case 'cli-not-found':
      return t('settings.managedHooks.state.cliNotFound')
    case 'disabled':
      return t('settings.managedHooks.state.disabled')
    case 'failed':
      return t('settings.managedHooks.state.failed')
  }
}

/**
 * Default-on managed status hooks for the supported provider CLIs.
 *
 * The card names every config file the setting can touch and reports "CLI not
 * found" instead of pretending a hook was installed for an absent tool.
 */
export default function ManagedHooksSettingsCard(): React.JSX.Element {
  const t = useT()
  const [state, setState] = useState<ManagedHooksStatePayload | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const result = await callApi(window.icode.managedHooks.get())
    if (result.ok) setState(result.value)
    else setError(result.error.message)
  }, [])

  useEffect(() => {
    void reload()
    return window.icode.managedHooks.onChanged((next) => {
      setState(next)
      setError(null)
    })
  }, [reload])

  const toggle = async (enabled: boolean): Promise<void> => {
    setSaving(true)
    setError(null)
    const result = await callApi(window.icode.managedHooks.setEnabled({ enabled }))
    if (result.ok) setState(result.value)
    else setError(result.error.message)
    setSaving(false)
  }

  return (
    <SettingsCard title={t('settings.managedHooks.title')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            {t('settings.managedHooks.description')}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[11.5px]">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--color-accent)]"
            checked={state?.enabled ?? true}
            disabled={saving || state === null}
            onChange={(event) => void toggle(event.target.checked)}
            data-testid="settings-managed-hooks-enabled"
          />
          {t('settings.managedHooks.enabled')}
        </label>
      </div>

      <div className="mt-3 space-y-2 border-t border-line pt-3 text-[10.5px] leading-relaxed text-muted-foreground">
        {state?.providers.map((provider) => (
          <div
            key={provider.provider}
            className="rounded-md border border-border/70 px-3 py-2"
            data-testid={`settings-managed-hooks-${provider.provider}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">{provider.label}</span>
              <span
                className={provider.state === 'failed' ? 'text-signal' : 'text-foreground'}
              >
                {stateLabel(provider.state, t)}
              </span>
            </div>
            {provider.configPath.length > 0 ? (
              <div className="mt-1 break-all font-mono text-[10px]">
                {t('settings.managedHooks.configPath', { path: provider.configPath })}
              </div>
            ) : null}
            {provider.detail !== null ? (
              <div className="mt-1 text-signal">{provider.detail}</div>
            ) : null}
          </div>
        ))}
        {state === null ? <div>—</div> : null}
        <p>{t('settings.managedHooks.restartHint')}</p>
        <p>{t('settings.managedHooks.wslHint')}</p>
        {error !== null ? (
          <p className="text-signal" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsCard>
  )
}
