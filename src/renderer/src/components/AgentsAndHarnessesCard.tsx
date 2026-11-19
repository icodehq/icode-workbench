import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import type { HarnessDetection } from '../../../shared/domain/harness'
import { isManagedHookProvider } from '../../../shared/domain/managed-hook-providers'
import { useT } from '../i18n/use-i18n'
import SettingsCard from './SettingsCard'
import {
  agentMasterState,
  buildAgentRows,
  visibleAgentRows,
  type AgentRow,
  type AgentStatus
} from './agents-and-harnesses-view'
import { useAgentStatus } from './use-agent-status'

function statusLabel(status: AgentStatus, t: ReturnType<typeof useT>): string {
  switch (status) {
    case 'checking':
      return t('settings.agents.state.checking')
    case 'failed':
      return t('settings.agents.state.failed')
    case 'partial':
      return t('settings.agents.state.partial')
    case 'unsupported':
      return t('settings.agents.state.unsupported')
    case 'installed':
      return t('settings.agents.state.installed')
    case 'plugin':
      return t('settings.agents.state.plugin')
    case 'status-off':
      return t('settings.agents.state.statusOff')
    case 'not-installed':
      return t('settings.agents.state.notInstalled')
    case 'launch-only':
      return t('settings.agents.state.launchOnly')
    case 'missing':
      return t('settings.agents.state.missing')
  }
}

function statusTone(status: AgentStatus): string {
  if (status === 'failed' || status === 'partial' || status === 'unsupported') {
    return 'text-signal'
  }
  if (status === 'installed' || status === 'plugin') return 'text-add'
  return 'text-muted-foreground'
}

function rowTestId(row: AgentRow): string {
  return isManagedHookProvider(row.id)
    ? `settings-managed-hooks-${row.id}`
    : `settings-agent-${row.id}`
}

function AgentRowView({
  row,
  expanded,
  onToggle
}: {
  row: AgentRow
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div
      className="rounded-md border border-border/70 px-3 py-2"
      data-testid={rowTestId(row)}
      data-agent-status={row.status}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 text-left"
        aria-expanded={expanded}
        onClick={onToggle}
        data-testid={`settings-agent-expand-${row.id}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-foreground">
            {row.label}
          </span>
          {row.version !== null ? (
            <span className="block font-mono text-[10px] text-muted-foreground">
              {row.version}
            </span>
          ) : null}
        </span>
        <span className={`shrink-0 text-[10px] ${statusTone(row.status)}`}>
          {statusLabel(row.status, t)}
        </span>
        {expanded ? (
          <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded ? (
        <div className="mt-2 space-y-1 border-t border-border/60 pt-2 text-[10.5px] leading-relaxed text-muted-foreground">
          {row.configPath !== null ? (
            <div className="break-all font-mono text-[10px]">
              {t('settings.agents.configPath', { path: row.configPath })}
            </div>
          ) : null}
          {row.executablePath !== null ? (
            <div className="break-all font-mono text-[10px]">
              {t('settings.agents.executablePath', { path: row.executablePath })}
            </div>
          ) : null}
          {row.detail !== null ? <div className="text-signal">{row.detail}</div> : null}
          {row.integrated ? <p>{t('settings.agents.wslHint')}</p> : null}
          {row.integrated ? <p>{t('settings.agents.restartHint')}</p> : null}
          {row.status === 'launch-only' ? <p>{t('settings.agents.launchOnlyHint')}</p> : null}
          {row.status === 'status-off' ? <p>{t('settings.agents.offHint')}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * One place to see which agents are present and whether their status integration
 * is working. Managed hooks and the OpenCode plugin remain separate installers;
 * this card intentionally presents them as one user-facing switch.
 */
export default function AgentsAndHarnessesCard({
  harnesses,
  harnessLoading,
  harnessError,
  refreshing,
  onRefresh
}: {
  harnesses: HarnessDetection[]
  harnessLoading: boolean
  harnessError: AppError | null
  refreshing: boolean
  onRefresh: () => void
}): React.JSX.Element {
  const t = useT()
  const {
    managedHooks,
    opencode,
    managedError,
    opencodeError,
    saving,
    error,
    reload,
    setEnabled
  } = useAgentStatus()
  const [showAll, setShowAll] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const masterRef = useRef<HTMLInputElement>(null)

  const rows = useMemo(
    () =>
      buildAgentRows({
        harnesses,
        harnessLoading,
        managedHooks,
        managedError,
        opencode,
        opencodeError
      }),
    [harnesses, harnessLoading, managedHooks, managedError, opencode, opencodeError]
  )
  const visible = visibleAgentRows(rows, showAll)
  const hiddenCount = rows.length - visibleAgentRows(rows, false).length
  const integrations = rows.filter((row) => row.integrated && row.id !== 'opencode').length
  const master = agentMasterState(managedHooks, opencode, managedError, opencodeError)

  useEffect(() => {
    if (masterRef.current !== null) masterRef.current.indeterminate = master.indeterminate
  }, [master.indeterminate])

  const toggleRow = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const retry = (): void => {
    void reload()
    onRefresh()
  }

  const sourceErrors = [managedError, opencodeError].filter(
    (value): value is string => value !== null
  )

  return (
    <SettingsCard title={t('settings.agents.title')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            {t('settings.agents.description')}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {t('settings.agents.summary', {
              agents: rows.length,
              integrations
            })}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[11.5px]">
          <input
            ref={masterRef}
            type="checkbox"
            className="h-4 w-4 accent-[var(--color-accent)]"
            checked={master.checked}
            disabled={saving || master.disabled}
            onChange={(event) => void setEnabled(event.target.checked)}
            data-testid="settings-agent-status-enabled"
          />
          {t('settings.agents.enabled')}
        </label>
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">
        {master.indeterminate ? `${t('settings.agents.partial')}. ` : ''}
        {t('settings.agents.enabledHelp')}
      </p>

      {harnessLoading ? (
        <p className="mt-3 text-[10.5px] text-muted-foreground">
          {t('settings.agents.loading')}
        </p>
      ) : null}
      {harnessError !== null ? (
        <div className="mt-3 flex items-center gap-2 text-[10.5px] text-signal" role="alert">
          <span>{t('settings.agents.detectionFailed', { message: harnessError.message })}</span>
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-[10px] text-foreground disabled:opacity-40"
            onClick={retry}
            disabled={refreshing || saving}
          >
            <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
            {t('common.retryConnection')}
          </button>
        </div>
      ) : null}
      {sourceErrors.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10.5px] text-signal" role="alert">
          <span>{sourceErrors.join('; ')}</span>
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-[10px] text-foreground disabled:opacity-40"
            onClick={retry}
            disabled={refreshing || saving}
          >
            <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
            {t('common.retryConnection')}
          </button>
        </div>
      ) : null}

      <div className="mt-3 space-y-2 border-t border-line pt-3" data-testid="settings-harnesses">
        {visible.map((row) => (
          <AgentRowView
            key={row.id}
            row={row}
            expanded={expanded.has(row.id)}
            onToggle={() => toggleRow(row.id)}
          />
        ))}
        {visible.length === 0 ? (
          <p className="text-[10.5px] text-muted-foreground">{t('settings.agents.none')}</p>
        ) : null}
      </div>

      {hiddenCount > 0 || showAll ? (
        <button
          type="button"
          className="mt-3 inline-flex h-7 items-center rounded-md border border-border px-2.5 text-[10.5px] hover:bg-muted"
          onClick={() => setShowAll((current) => !current)}
          data-testid="settings-harnesses-more"
        >
          {showAll
            ? t('settings.agents.showLess')
            : t('settings.agents.showAll', { count: rows.length })}
        </button>
      ) : null}

      {error !== null ? (
        <p className="mt-2 text-[10.5px] text-signal" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsCard>
  )
}
