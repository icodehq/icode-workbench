import { RefreshCw, Server, TerminalSquare } from 'lucide-react'
import type { RuntimeInfo } from '../../../../shared/icode-api'
import type { WorkspaceState } from '../../state/workspace'
import { hostStatus } from '../../state/host-status'
import { useT, useTp } from '../../i18n/use-i18n'

type Props = {
  state: WorkspaceState
  taskSlotCount: number
  maxConcurrent: number
  runtime: RuntimeInfo | null
  refreshing: boolean
  onRefresh: () => void
  onRetryHost: () => void
}

/** Compact global truth for the sidebar footer. */
export default function SidebarStatus({
  state,
  taskSlotCount,
  maxConcurrent,
  runtime,
  refreshing,
  onRefresh,
  onRetryHost
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const host = hostStatus(state)
  const available = state.harnesses.filter((entry) => entry.state === 'available').length
  const liveSessions = state.sessions.filter(
    (session) =>
      session.role !== 'supervisor' &&
      (session.state === 'live' || session.state === 'starting')
  ).length
  return (
    <div className="shrink-0 border-t border-border px-2 py-1.5 text-[9px] text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className={`inline-flex min-w-0 items-center gap-1 rounded px-0.5 hover:bg-muted ${
            host === 'unreachable' ? 'text-signal' : ''
          }`}
          title={host === 'unreachable' ? t('status.hostTooltipRetry') : t('status.hostTooltip')}
          onClick={onRetryHost}
          disabled={refreshing}
          data-testid="host-status"
          data-host-status={host}
        >
          <Server size={10} />
          <span className="truncate">
            {host === 'reachable'
              ? t('host.short')
              : host === 'unreachable'
                ? t('host.shortDown')
                : t('host.shortUnknown')}
          </span>
        </button>
        <span
          className="ml-auto inline-flex shrink-0 items-center gap-0.5"
          title={t('status.globalTaskSlots')}
          data-testid="task-slots"
        >
          {taskSlotCount}/{maxConcurrent}
        </span>
        <span
          className="inline-flex shrink-0 items-center gap-0.5"
          title={tp('status.liveSessions', liveSessions)}
          data-testid="live-sessions"
        >
          <TerminalSquare size={10} />
          {liveSessions}
        </span>
        <button
          type="button"
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          onClick={onRefresh}
          disabled={refreshing}
          title={t('status.refreshTitle')}
          data-testid="refresh-all"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="mt-0.5 flex items-center justify-between font-mono text-[7.5px] text-muted-foreground/70">
        <span title={t('status.harnessesTooltip')} data-testid="harness-summary">
          {t('status.harnessesCount', { available, total: state.harnesses.length || 4 })}
        </span>
        <span
          title={
            runtime
              ? t('status.electronTitle', { electron: runtime.electron ?? '?', node: runtime.node })
              : undefined
          }
        >
          v{runtime?.appVersion ?? '—'}
        </span>
      </div>
    </div>
  )
}
