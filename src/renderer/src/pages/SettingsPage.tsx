import { Check, Monitor, Moon, RefreshCw, Sun } from 'lucide-react'
import type { RuntimeInfo } from '../../../shared/icode-api'
import type { HarnessDetection } from '../../../shared/domain/harness'
import type { AssistantSettingsPayload } from '../../../shared/schemas/assistant'
import type { AssistantStatus } from '../../../shared/domain/assistant'
import type { ThemeName, ThemePreference } from '../theme/apply-theme'
import { hostStatus } from '../state/host-status'
import type { WorkspaceState } from '../state/workspace'
import ScmSettingsCard from '../scm/ScmSettingsCard'
import FilesSettingsCard from '../files/FilesSettingsCard'
import SettingsCard from '../components/SettingsCard'
import AssistantSettingsCard from '../components/AssistantSettingsCard'
import LanguageSettingsCard from '../components/LanguageSettingsCard'
import { useT } from '../i18n/use-i18n'
import type { Translator } from '../i18n/i18n-store'

type SettingsPageProps = {
  state: WorkspaceState
  runtime: RuntimeInfo | null
  maxConcurrent: number
  onSetMaxConcurrent: (value: number) => Promise<void>
  refreshing: boolean
  onRefresh: () => void
  themePreference: ThemePreference
  resolvedTheme: ThemeName
  onSetTheme: (preference: ThemePreference) => void
  assistantSettings: AssistantSettingsPayload
  assistantStatus: AssistantStatus
  assistantHarness: string | null
  assistantTarget: string | null
  onSaveAssistantSettings: (settings: AssistantSettingsPayload) => Promise<void>
}

function harnessState(
  detection: HarnessDetection,
  t: Translator
): { label: string; tone: string } {
  if (detection.state === 'available') {
    return { label: t('common.available'), tone: 'border-add/50 bg-add-weak text-add' }
  }
  if (detection.state === 'detection_failed') {
    return { label: t('common.probeFailed'), tone: 'border-signal-line bg-signal-weak text-signal' }
  }
  return { label: t('common.missing'), tone: 'border-border bg-muted text-muted-foreground' }
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
      <span className="min-w-0 break-words text-right text-foreground">{children}</span>
    </div>
  )
}

export default function SettingsPage({
  state,
  runtime,
  maxConcurrent,
  onSetMaxConcurrent,
  refreshing,
  onRefresh,
  themePreference,
  resolvedTheme,
  onSetTheme,
  assistantSettings,
  assistantStatus,
  assistantHarness,
  assistantTarget,
  onSaveAssistantSettings
}: SettingsPageProps): React.JSX.Element {
  const t = useT()
  const host = hostStatus(state)
  const available = state.harnesses.filter((entry) => entry.state === 'available').length

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="settings-view">
      <div className="mx-auto w-full max-w-5xl px-5 py-5">
        <h1 className="text-[20px] font-semibold tracking-[-0.02em]">{t('settings.title')}</h1>
        <p className="mt-1 max-w-2xl text-[11.5px] leading-relaxed text-muted-foreground">
          {t('settings.subtitle')}
        </p>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-4">
            <SettingsCard title={t('settings.appearance.title')}>
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="text-[12px] font-medium text-foreground">{t('settings.appearance.theme')}</p>
                <span className="text-[10.5px] text-muted-foreground">{t('settings.appearance.currently', { theme: resolvedTheme })}</span>
              </div>
              <div
                className="mt-2 inline-flex flex-wrap gap-1 rounded-md border border-border bg-muted/40 p-1"
                role="group"
                aria-label={t('settings.appearance.title')}
              >
                {(
                  [
                    ['system', t('common.system'), Monitor],
                    ['dark', t('common.dark'), Moon],
                    ['light', t('common.light'), Sun]
                  ] as const
                ).map(([value, label, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    className={`inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-[11px] ${
                      themePreference === value
                        ? 'bg-card text-accent shadow-sm'
                        : 'text-muted-foreground hover:bg-card/60 hover:text-foreground'
                    }`}
                    onClick={() => onSetTheme(value)}
                    aria-pressed={themePreference === value}
                    data-testid={`settings-theme-${value}`}
                  >
                    <Icon size={13} />
                    {label}
                    {themePreference === value ? <Check size={11} /> : null}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[10.5px] leading-relaxed text-muted-foreground">
                {t('settings.appearance.help')}
              </p>
            </SettingsCard>

            <LanguageSettingsCard />

            <AssistantSettingsCard
              settings={assistantSettings}
              status={assistantStatus}
              harness={assistantHarness}
              target={assistantTarget}
              onSave={onSaveAssistantSettings}
            />

            <ScmSettingsCard />

            <FilesSettingsCard />

            <SettingsCard title={t('settings.taskExecution.title')}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <label className="text-[12px] font-medium text-foreground" htmlFor="settings-concurrency">
                    {t('settings.taskExecution.runAtOnce')}
                  </label>
                  <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                    {t('settings.taskExecution.help')}
                  </p>
                </div>
                <select
                  id="settings-concurrency"
                  className="h-8 rounded-md border border-border bg-muted/40 px-2 text-[11.5px] text-foreground"
                  value={maxConcurrent}
                  onChange={(event) => void onSetMaxConcurrent(Number(event.target.value))}
                  data-testid="settings-concurrency"
                >
                  {[1, 2, 3, 4].map((value) => (
                    <option key={value} value={value}>
                      {t(value === 1 ? 'settings.taskExecution.task.one' : 'settings.taskExecution.task.other', { count: value })}
                    </option>
                  ))}
                </select>
              </div>
            </SettingsCard>

            <SettingsCard title={t('settings.harnesses.title')}>
              <ul className="space-y-2" data-testid="settings-harnesses">
                {state.harnesses.map((entry) => {
                  const stateInfo = harnessState(entry, t)
                  return (
                    <li
                      key={entry.harness}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 text-[12px] font-medium text-foreground">
                        {entry.harness}
                      </span>
                      {entry.state === 'available' && entry.version ? (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {entry.version}
                        </span>
                      ) : null}
                      <span className={`rounded-full border px-2 py-0.5 text-[9.5px] ${stateInfo.tone}`}>
                        {stateInfo.label}
                      </span>
                    </li>
                  )
                })}
                {state.harnesses.length === 0 ? (
                  <li className="text-[11px] text-muted-foreground">{t('settings.harnesses.none')}</li>
                ) : null}
              </ul>
            </SettingsCard>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <SettingsCard
              title={t('settings.hostRuntime.title')}
              action={
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[10.5px] hover:bg-muted disabled:opacity-40"
                  onClick={onRefresh}
                  disabled={refreshing}
                  data-testid="settings-refresh"
                >
                  <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
                  {host === 'unreachable' ? t('common.retryConnection') : t('common.refresh')}
                </button>
              }
            >
              <Row label={t('settings.hostRuntime.host')}>
                <span className={host === 'unreachable' ? 'text-signal' : host === 'reachable' ? 'text-add' : ''}>
                  {host === 'reachable'
                    ? t('host.reachable')
                    : host === 'unreachable'
                      ? t('host.unreachable')
                      : t('host.unknown')}
                </span>
              </Row>
              <Row label={t('settings.hostRuntime.harnesses')}>
                <span className="font-mono">
                  {t('settings.hostRuntime.availableCount', {
                    available,
                    total: state.harnesses.length || 4
                  })}
                </span>
              </Row>
              <Row label={t('settings.hostRuntime.projects')}>
                <span className="font-mono">{state.repos.length}</span>
              </Row>
              <Row label={t('settings.hostRuntime.app')}>
                <span className="font-mono">v{runtime?.appVersion ?? '—'}</span>
              </Row>
              <Row label={t('settings.hostRuntime.electron')}>
                <span className="font-mono">{runtime?.electron ?? '—'}</span>
              </Row>
              <Row label={t('settings.hostRuntime.node')}>
                <span className="font-mono">{runtime?.node ?? '—'}</span>
              </Row>
              <Row label={t('settings.hostRuntime.platform')}>
                <span className="font-mono">{runtime?.platform ?? '—'}</span>
              </Row>
            </SettingsCard>

            <SettingsCard title={t('settings.about.title')}>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t('settings.about.body')}
              </p>
            </SettingsCard>
          </div>
        </div>
      </div>
    </div>
  )
}
