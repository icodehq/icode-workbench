import { AlertTriangle, ArrowDown, ArrowUp, GitBranch } from 'lucide-react'
import { formatDateTime } from '../../../../shared/i18n'
import { useEditorBlameStatus } from '../../editor/editor-status-store'
import { useLocale, useT, useTp } from '../../i18n/use-i18n'
import { useScmStatusSummary } from '../../scm/scm-status-store'

type Props = {
  onOpenSourceControl: () => void
}

/**
 * The compact session truth strip. Host, slots and live counts live in the
 * sidebar footer; the focused session's branch and caret blame stay next to
 * the terminal so source-control context is never a global row.
 */
export default function SessionStatusStrip({
  onOpenSourceControl
}: Props): React.JSX.Element | null {
  const t = useT()
  const tp = useTp()
  const locale = useLocale()
  const gitSummary = useScmStatusSummary()
  const blame = useEditorBlameStatus()
  if (gitSummary === null && blame === null) return null

  return (
    <footer
      className="flex h-[24px] shrink-0 items-center gap-2 overflow-hidden border-t border-border bg-card px-3 text-[10px] text-muted-foreground"
      data-testid="session-status-strip"
    >
      {gitSummary !== null ? (
        <button
          type="button"
          className="inline-flex min-w-0 shrink items-center gap-1 rounded px-0.5 hover:bg-muted"
          title={t('status.gitTooltip', {
            branch: gitSummary.branch ?? t('status.detachedHead'),
            upstream: gitSummary.upstream ? ` → ${gitSummary.upstream}` : '',
            staged: gitSummary.staged,
            changed: gitSummary.changed,
            untracked: gitSummary.untracked
          })}
          onClick={onOpenSourceControl}
          data-testid="statusbar-branch"
          data-session-id={gitSummary.sessionId}
        >
          <GitBranch size={11} />
          <span className="max-w-[150px] truncate">
            {gitSummary.branch ?? t('status.detached')}
          </span>
          {gitSummary.operation ? (
            <span
              className="rounded bg-signal-weak px-1 uppercase text-signal"
              title={t('status.operationProgress', { operation: gitSummary.operation })}
            >
              {gitSummary.operation}
            </span>
          ) : null}
          {gitSummary.conflicts > 0 ? (
            <span
              className="inline-flex items-center gap-0.5 text-signal"
              title={tp('status.conflicts', gitSummary.conflicts)}
            >
              <AlertTriangle size={10} />
              {gitSummary.conflicts}
            </span>
          ) : null}
          {gitSummary.ahead > 0 ? (
            <span
              className="inline-flex items-center gap-0.5"
              title={tp('status.ahead', gitSummary.ahead)}
            >
              <ArrowUp size={10} />
              {gitSummary.ahead}
            </span>
          ) : null}
          {gitSummary.behind > 0 ? (
            <span
              className="inline-flex items-center gap-0.5"
              title={tp('status.behind', gitSummary.behind)}
            >
              <ArrowDown size={10} />
              {gitSummary.behind}
            </span>
          ) : null}
        </button>
      ) : null}
      {blame !== null ? (
        <span
          className="inline-flex min-w-0 shrink items-center gap-1 rounded px-0.5"
          title={`${blame.path}:${String(blame.line)} · ${blame.oid.slice(0, 8)} · ${
            blame.committed ? blame.author : t('status.notCommitted')
          } · ${formatDateTime(locale, blame.authorTime * 1000)}${blame.summary ? ` · ${blame.summary}` : ''}`}
          data-testid="statusbar-blame"
        >
          <span className="max-w-[120px] truncate text-foreground">
            {blame.committed ? blame.author : t('status.you')}
          </span>
          <span className="max-w-[180px] truncate">
            {blame.committed ? blame.summary : t('status.uncommitted')}
          </span>
        </span>
      ) : null}
    </footer>
  )
}
