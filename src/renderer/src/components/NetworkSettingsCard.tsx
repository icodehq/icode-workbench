import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  PROXY_MODES,
  validateNetworkProxySettings,
  type NetworkProxySettings,
  type ProxyMode
} from '../../../shared/domain/network'
import type { MessageKey } from '../../../shared/i18n/messages'
import { useT } from '../i18n/use-i18n'
import SettingsCard from './SettingsCard'

const MODE_KEYS: Record<ProxyMode, MessageKey> = {
  system: 'settings.network.mode.system',
  manual: 'settings.network.mode.manual',
  off: 'settings.network.mode.off'
}

const MODE_HELP_KEYS: Record<ProxyMode, MessageKey> = {
  system: 'settings.network.mode.systemHelp',
  manual: 'settings.network.mode.manualHelp',
  off: 'settings.network.mode.offHelp'
}

function Row({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 text-[11.5px] last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1 text-right">{children}</div>
    </div>
  )
}

const inputClass =
  'h-7 w-full max-w-[260px] rounded border border-border bg-muted/40 px-2 text-left text-[11px] text-foreground outline-none focus:border-line-strong disabled:opacity-50'

/**
 * One app-wide proxy policy.
 *
 * Manual mode is the exact path: the same two URLs and bypass list reach
 * Chromium, Git, terminals, and WSL. System mode reuses the OS proxy and fills
 * the non-Chromium environment where possible.
 */
export default function NetworkSettingsCard(): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState<NetworkProxySettings>(
    DEFAULT_NETWORK_PROXY_SETTINGS
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hydrated = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.icode.network.settings()
      if (cancelled) return
      if (result.ok) {
        // A locale change re-runs this effect but must not overwrite a draft.
        if (!hydrated.current) {
          hydrated.current = true
          setDraft(result.value)
        }
      } else if (!hydrated.current) {
        setError(t('settings.network.error.load'))
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [t])

  const manual = draft.mode === 'manual'

  function update(patch: Partial<NetworkProxySettings>): void {
    setDraft((current) => ({ ...current, ...patch }))
    setSaved(false)
    setError(null)
  }

  async function save(): Promise<void> {
    const issues = validateNetworkProxySettings(draft)
    if (issues.length > 0) {
      setSaved(false)
      if (issues.some((issue) => issue.field === 'noProxy')) {
        setError(t('settings.network.error.noProxy'))
      } else if (
        issues.some(
          (issue) =>
            issue.field === 'httpProxyUrl' || issue.field === 'httpsProxyUrl'
        )
      ) {
        setError(t('settings.network.error.url'))
      } else {
        setError(t('settings.network.error.manual'))
      }
      return
    }
    setSaving(true)
    setError(null)
    const result = await window.icode.network.setSettings({ settings: draft })
    setSaving(false)
    if (!result.ok) {
      setError(t('settings.network.error.save'))
      return
    }
    setDraft(result.value)
    setSaved(true)
  }

  return (
    <SettingsCard title={t('settings.network.title')}>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        {t('settings.network.description')}
      </p>
      <div className="space-y-1">
        <Row label={t('settings.network.mode')}>
          <select
            className="h-7 rounded border border-border bg-muted/40 px-2 text-[11px] text-foreground"
            value={draft.mode}
            disabled={loading}
            onChange={(event) => update({ mode: event.target.value as ProxyMode })}
            data-testid="settings-network-mode"
          >
            {PROXY_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(MODE_KEYS[mode])}
              </option>
            ))}
          </select>
        </Row>
        <p className="pb-1 text-[10.5px] leading-relaxed text-muted-foreground">
          {t(MODE_HELP_KEYS[draft.mode])}
        </p>
        <Row label={t('settings.network.http')}>
          <input
            className={inputClass}
            value={draft.httpProxyUrl}
            disabled={!manual || loading}
            placeholder={t('settings.network.httpPlaceholder')}
            spellCheck={false}
            onChange={(event) => update({ httpProxyUrl: event.target.value })}
            data-testid="settings-network-http-proxy"
          />
        </Row>
        <Row label={t('settings.network.https')}>
          <input
            className={inputClass}
            value={draft.httpsProxyUrl}
            disabled={!manual || loading}
            placeholder={t('settings.network.httpsPlaceholder')}
            spellCheck={false}
            onChange={(event) => update({ httpsProxyUrl: event.target.value })}
            data-testid="settings-network-https-proxy"
          />
        </Row>
        <Row label={t('settings.network.noProxy')}>
          <input
            className={inputClass}
            value={draft.noProxy}
            disabled={!manual || loading}
            placeholder={t('settings.network.noProxyPlaceholder')}
            spellCheck={false}
            onChange={(event) => update({ noProxy: event.target.value })}
            data-testid="settings-network-no-proxy"
          />
        </Row>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="rounded bg-muted px-3 py-1 text-[11px] font-medium text-foreground hover:bg-muted/80 disabled:opacity-50"
          disabled={saving || loading}
          onClick={() => void save()}
          data-testid="settings-network-save"
        >
          {saving ? t('settings.network.saving') : t('settings.network.save')}
        </button>
        {saved ? (
          <span className="text-[11px] text-muted-foreground" data-testid="settings-network-saved">
            {t('settings.network.saved')}
          </span>
        ) : null}
      </div>
      {error !== null ? (
        <p
          role="alert"
          className="mt-2 text-[10.5px] text-signal"
          data-testid="settings-network-error"
        >
          {error}
        </p>
      ) : null}
      <p className="mt-3 text-[10.5px] leading-relaxed text-muted-foreground">
        {t('settings.network.notes')}
      </p>
      <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
        {t('settings.network.notes.wsl')}
      </p>
    </SettingsCard>
  )
}
