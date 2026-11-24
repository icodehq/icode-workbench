import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import {
  activityDetailsHint,
  activityDetailsLabel,
  authorityNote,
  harnessName,
  sessionStateLabelFor
} from './status'
import TargetBadge from './TargetBadge'
import { useT } from '../i18n/use-i18n'
import { formatDateTime } from '../../../shared/i18n'
import { getLocale } from '../i18n/i18n-store'

type Props = {
  session: SessionSummary
  repo: RepositorySummary | null
  onClose: () => void
}

/** Diagnostics for one session: identity, host truth and worktree coordinates. */
export default function SessionDetailsDrawer({
  session,
  repo,
  onClose
}: Props): React.JSX.Element {
  const t = useT()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const worktree = session.worktree
  const diagnostics = [
    `session: ${session.id}`,
    `state: ${session.state}`,
    `authority: ${session.authority}`,
    `reason: ${session.reason}`,
    `worktree: ${worktree?.path ?? '(primary checkout)'}`,
    `branch: ${worktree?.branch ?? repo?.currentBranch ?? '—'}`,
    `base: ${worktree?.baseOid ?? '—'}`,
    session.error
      ? `error: ${session.error.code}: ${session.error.message}${
          session.error.detail ? ` — ${session.error.detail}` : ''
        }`
      : null
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
  const rows: Array<[string, React.ReactNode]> = [
    [
      t('sessionDetails.repository'),
      <span key="repo" className="flex flex-wrap items-center gap-1.5">
        {repo?.displayName ?? t('sessionDetails.unknownProject')}
        {repo ? <TargetBadge repo={repo} compact /> : null}
      </span>
    ],
    [t('sessionDetails.harness'), harnessName(session.harness)],
    [
      t('sessionDetails.role'),
      session.role === 'supervisor'
        ? t('sessionDetails.supervisor')
        : t('sessionDetails.interactive')
    ],
    [t('sessionDetails.status'), sessionStateLabelFor(session, null)],
    [
      'Activity',
      <span key="activity" title={activityDetailsHint(session.activity, session.harness)}>
        {activityDetailsLabel(session.activity, session.harness)}
      </span>
    ],
    [
      t('sessionDetails.prompt'),
      <span
        key="prompt"
        className="line-clamp-3 whitespace-pre-wrap break-words text-[10.5px]"
        title={session.activity?.prompt ?? undefined}
        data-testid="session-prompt"
      >
        {session.activity?.prompt ?? t('sessionDetails.empty')}
      </span>
    ],
    [
      t('sessionDetails.lastMessage'),
      <span
        key="message"
        className="line-clamp-3 whitespace-pre-wrap break-words text-[10.5px]"
        title={session.activity?.message ?? undefined}
        data-testid="session-last-message"
      >
        {session.activity?.message ?? t('sessionDetails.empty')}
      </span>
    ],
    [
      t('sessionDetails.subagents'),
      session.activity?.subagents.length ? (
        <ul key="subagents" className="space-y-0.5" data-testid="session-details-subagents">
          {session.activity.subagents.map((child) => (
            <li key={child.id} className="flex min-w-0 items-center gap-1.5">
              <span className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{child.label}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {child.state}
                {child.toolName ? ` · ${child.toolName}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        t('sessionDetails.empty')
      )
    ],
    [t('sessionDetails.updated'), formatDateTime(getLocale(), session.updatedAt)]
  ]

  return (
    <div
      className="fixed inset-0 z-[65] bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label={t('session.details')}
      data-testid="session-details-drawer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <aside className="icode-drawer absolute bottom-3 right-3 top-3 flex w-[min(420px,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-[var(--icode-shadow-overlay)]">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">{t('session.details')}</h2>
            <p className="mt-0.5 truncate text-[12px] font-medium text-foreground">
              {session.title}
            </p>
            <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
              {repo?.displayName ?? t('sessionDetails.unknownProject')}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
            data-testid="session-details-close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <dl className="space-y-2 text-[11px]">
            {rows.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[82px_minmax(0,1fr)] gap-2 border-b border-border/60 pb-1.5 last:border-0">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
          {/*
           * Paths, branches, baselines, host authority and raw errors are for
           * support, not for the main details view. They stay one click away.
           */}
          <details className="mt-3 text-[10px] text-muted-foreground" data-testid="session-technical-details">
            <summary className="cursor-pointer select-none">
              {t('session.problem.technical')}
            </summary>
            <div className="mt-2 space-y-1 rounded-md border border-border bg-background px-3 py-2">
              <p>{authorityNote(session)}</p>
              {session.error ? (
                <p className="break-words font-mono text-destructive">
                  {session.error.message}
                  {session.error.detail ? ` — ${session.error.detail}` : ''}
                </p>
              ) : null}
              {session.exitCode !== null ? (
                <p>
                  {t('sessionDetails.exitCode')}{' '}
                  <span className="font-mono">{session.exitCode}</span>
                </p>
              ) : null}
              <dl className="mt-2 space-y-1 font-mono">
                <div className="break-all">
                  {t('session.technical.session')}{' '}
                  <span className="text-foreground">{session.id}</span>
                </div>
                <div className="break-all">
                  {t('session.technical.path')}{' '}
                  <span className="text-foreground">
                    {worktree?.path ?? repo?.path ?? '—'}
                  </span>
                </div>
                <div>
                  {t('session.technical.branch')}{' '}
                  <span className="text-foreground">
                    {worktree?.branch ?? repo?.currentBranch ?? '—'}
                  </span>
                </div>
                <div>
                  {t('session.technical.baseline')}{' '}
                  <span className="text-foreground">
                    {worktree ? worktree.baseOid.slice(0, 12) : '—'}
                  </span>
                </div>
                <div>
                  {t('sessionDetails.authority')}{' '}
                  <span className="text-foreground">
                    {t(
                      session.authority === 'host'
                        ? 'sessionDetails.authority.host'
                        : session.authority === 'persisted'
                          ? 'sessionDetails.authority.persisted'
                          : 'sessionDetails.authority.unreachable'
                    )}
                  </span>
                </div>
                <div>
                  {t('sessionDetails.host')}{' '}
                  <span className="text-foreground">
                    {session.authority === 'unreachable'
                      ? t('sessionDetails.unreachable')
                      : t('sessionDetails.reachable')}
                  </span>
                </div>
                {session.incarnationId ? (
                  <div className="break-all">
                    {t('sessionDetails.incarnation')}{' '}
                    <span className="text-foreground">{session.incarnationId}</span>
                  </div>
                ) : null}
              </dl>
              <button
                type="button"
                className="mt-2 rounded-md border border-border px-2 py-1 text-[10px] hover:bg-muted"
                onClick={() => void navigator.clipboard?.writeText(diagnostics)}
                data-testid="session-copy-diagnostics"
              >
                {t('sessionDetails.copyDiagnostics')}
              </button>
            </div>
          </details>
        </div>
        <div className="flex items-center border-t border-border px-4 py-2.5">
          <span className="text-[10px] text-muted-foreground">{t('session.detailsDirect')}</span>
          <button
            type="button"
            className="ml-auto rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted"
            onClick={onClose}
          >
            {t('sessionDetails.close')}
          </button>
        </div>
      </aside>
    </div>
  )
}
