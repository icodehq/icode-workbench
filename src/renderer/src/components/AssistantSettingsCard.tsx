import { useEffect, useState } from 'react'
import type { AssistantSettingsPayload } from '../../../shared/schemas/assistant'
import type { AssistantStatus, AssistantTarget } from '../../../shared/domain/assistant'
import SettingsCard from './SettingsCard'
import { useT } from '../i18n/use-i18n'
import type { MessageKey } from '../../../shared/i18n'

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
      <span className="min-w-0 text-right text-foreground">{children}</span>
    </div>
  )
}

export default function AssistantSettingsCard({
  settings,
  status,
  harness,
  target,
  onSave
}: {
  settings: AssistantSettingsPayload
  status: AssistantStatus
  harness: string | null
  target: string | null
  onSave: (settings: AssistantSettingsPayload) => Promise<void>
}): React.JSX.Element {
  const t = useT()
  const statusKey: Record<AssistantStatus, MessageKey> = {
    working: 'assistant.status.working',
    idle: 'assistant.status.ready',
    offline: 'assistant.status.noHarness',
    error: 'assistant.status.needsAttention'
  }
  const [name, setName] = useState(settings.personaName)
  const [distros, setDistros] = useState<Array<{ name: string }>>([])

  useEffect(() => {
    setName(settings.personaName)
  }, [settings.personaName])

  useEffect(() => {
    let cancelled = false
    void window.icode.wsl
      .listDistros()
      .then((result) => {
        if (!cancelled && result.ok && result.value.status === 'ok') {
          setDistros(result.value.distros.map((distro) => ({ name: distro.name })))
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const targetValue =
    settings.target.kind === 'wsl' ? `wsl:${settings.target.distro}` : settings.target.kind

  const setTarget = (value: string): void => {
    const target: AssistantTarget =
      value === 'auto' || value === 'local'
        ? { kind: value }
        : { kind: 'wsl', distro: value.slice(4) }
    void onSave({ ...settings, target })
  }

  const setPreferredHarness = (harness: 'claude' | 'codex' | 'opencode'): void => {
    void onSave({
      ...settings,
      harnessPriority: [
        harness,
        ...settings.harnessPriority.filter((entry) => entry !== harness)
      ]
    })
  }

  const saveName = (): void => {
    const value = name.trim()
    if (value.length === 0 || value === settings.personaName) {
      setName(settings.personaName)
      return
    }
    void onSave({ ...settings, personaName: value })
  }

  return (
    <SettingsCard title={t('assistant.settings.title')}>
      <div className="space-y-1">
        <Row label={t('assistant.settings.name')}>
          <input
            className="h-7 w-40 rounded border border-border bg-muted/40 px-2 text-[11px] text-foreground outline-none focus:border-line-strong"
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                saveName()
              }
            }}
            data-testid="settings-mira-name"
          />
        </Row>
        <Row label={t('assistant.settings.status')}>
          <span data-testid="settings-mira-status">
            {t(statusKey[status])}
            {harness ? ` · ${harness}` : ''}
            {target ? ` · ${target}` : ''}
          </span>
        </Row>
        <Row label={t('assistant.settings.runOn')}>
          <select
            className="h-7 max-w-[240px] rounded border border-border bg-muted/40 px-2 text-[11px] text-foreground"
            value={targetValue}
            onChange={(event) => setTarget(event.target.value)}
            data-testid="settings-mira-target"
          >
            <option value="auto">{t('assistant.settings.autoTarget')}</option>
            <option value="local">{t('assistant.settings.localTarget')}</option>
            {distros.map((distro) => (
              <option key={distro.name} value={`wsl:${distro.name}`}>
                WSL · {distro.name}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t('assistant.settings.preferredHarness')}>
          <select
            className="h-7 rounded border border-border bg-muted/40 px-2 text-[11px] text-foreground"
            value={settings.harnessPriority[0]}
            onChange={(event) =>
              setPreferredHarness(
                event.target.value as 'claude' | 'codex' | 'opencode'
              )
            }
            data-testid="settings-mira-harness"
          >
            <option value="claude">{t('assistant.settings.claudeFirst')}</option>
            <option value="codex">{t('assistant.settings.codexFirst')}</option>
            <option value="opencode">{t('assistant.settings.opencodeFirst')}</option>
          </select>
        </Row>
        <Row label={t('assistant.settings.autoDispatch')}>
          <select
            className="h-7 rounded border border-border bg-muted/40 px-2 text-[11px] text-foreground"
            value={settings.autoDispatch.mode}
            onChange={(event) =>
              void onSave({
                ...settings,
                autoDispatch: {
                  ...settings.autoDispatch,
                  mode: event.target.value as AssistantSettingsPayload['autoDispatch']['mode']
                }
              })
            }
            data-testid="settings-mira-auto-dispatch"
          >
            <option value="off">{t('assistant.settings.offApproval')}</option>
            <option value="low-risk">{t('assistant.settings.lowRisk')}</option>
            <option value="all">{t('assistant.settings.allTasks')}</option>
          </select>
        </Row>
        <Row label={t('assistant.settings.notifications')}>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={settings.notifications.enabled}
              onChange={(event) =>
                void onSave({
                  ...settings,
                  notifications: {
                    ...settings.notifications,
                    enabled: event.target.checked
                  }
                })
              }
              data-testid="settings-mira-notifications"
            />
            {t('assistant.settings.enabled')}
          </label>
        </Row>
        <Row label={t('assistant.settings.quietMode')}>
          <select
            className="h-7 rounded border border-border bg-muted/40 px-2 text-[11px] text-foreground"
            value={settings.notifications.quietMode}
            onChange={(event) =>
              void onSave({
                ...settings,
                notifications: {
                  ...settings.notifications,
                  quietMode: event.target
                    .value as AssistantSettingsPayload['notifications']['quietMode']
                }
              })
            }
            data-testid="settings-mira-quiet-mode"
          >
            <option value="off">{t('assistant.settings.offOs')}</option>
            <option value="in-app">{t('assistant.settings.inApp')}</option>
            <option value="respect-hours">{t('assistant.settings.respectHours')}</option>
          </select>
        </Row>
      </div>
      <p className="mt-3 text-[10.5px] leading-relaxed text-muted-foreground">
        {t('assistant.settings.footnote')}
      </p>
    </SettingsCard>
  )
}
