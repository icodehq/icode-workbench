import { useEffect } from 'react'
import { Copy, X } from 'lucide-react'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import type { Notice } from '../state/workspace'
import {
  activityDetailsHint,
  activityDetailsLabel,
  authorityNote,
  harnessName,
  sessionStateLabelFor
} from './status'
import TargetBadge from './TargetBadge'

type Props = {
  session: SessionSummary
  repo: RepositorySummary | null
  notify: (notice: Notice) => void
  onClose: () => void
}

function Value({
  value,
  label,
  mono = false,
  onCopy
}: {
  value: string
  label: string
  mono?: boolean
  onCopy: () => void
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className={`min-w-0 truncate ${mono ? 'font-mono text-[10.5px]' : ''}`} title={value}>
        {value}
      </span>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onCopy}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
      >
        <Copy size={10} />
      </button>
    </span>
  )
}

/** Diagnostics for one session: identity, host truth and worktree coordinates. */
export default function SessionDetailsDrawer({
  session,
  repo,
  notify,
  onClose
}: Props): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const copy = async (value: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      notify({ tone: 'success', message: `Copied ${label}.` })
    } catch {
      notify({ tone: 'error', message: 'Clipboard is unavailable.' })
    }
  }

  const worktree = session.worktree
  const rows: Array<[string, React.ReactNode]> = [
    [
      'Repository',
      <span key="repo" className="flex flex-wrap items-center gap-1.5">
        {repo?.displayName ?? 'unknown project'}
        {repo ? <TargetBadge repo={repo} compact /> : null}
      </span>
    ],
    ['Harness', harnessName(session.harness)],
    ['Role', session.role === 'supervisor' ? 'Supervisor' : 'Interactive'],
    ['Status', sessionStateLabelFor(session, null)],
    ['Authority', session.authority],
    [
      'Activity',
      <span key="activity" title={activityDetailsHint(session.activity, session.harness)}>
        {activityDetailsLabel(session.activity, session.harness)}
      </span>
    ],
    ['Updated', new Date(session.updatedAt).toLocaleString()],
    ['Host', session.authority === 'unreachable' ? 'Unreachable' : 'Reachable'],
    [
      'Worktree',
      worktree ? (
        <Value
          value={worktree.path}
          label="worktree path"
          mono
          onCopy={() => void copy(worktree.path, 'worktree path')}
        />
      ) : (
        'primary checkout'
      )
    ],
    [
      'Branch',
      worktree ? (
        <Value
          value={worktree.branch}
          label="branch"
          mono
          onCopy={() => void copy(worktree.branch, 'branch')}
        />
      ) : (
        '—'
      )
    ],
    ['Base', worktree ? <span key="base" className="font-mono text-[10.5px]">{worktree.baseOid.slice(0, 12)}</span> : '—'],
    [
      'Session',
      <Value value={session.id} label="session ID" mono onCopy={() => void copy(session.id, 'session ID')} />
    ],
    [
      'Incarnation',
      session.incarnationId ? (
        <Value
          value={session.incarnationId}
          label="incarnation"
          mono
          onCopy={() => void copy(session.incarnationId!, 'incarnation')}
        />
      ) : (
        '—'
      )
    ]
  ]

  return (
    <div
      className="fixed inset-0 z-[65] bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="Session details"
      data-testid="session-details-drawer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <aside className="icode-drawer absolute bottom-3 right-3 top-3 flex w-[min(420px,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-[var(--icode-shadow-overlay)]">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">Session details</h2>
            <p className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground">
              {worktree?.branch ?? 'primary checkout'} · {repo?.displayName ?? 'unknown project'}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label="Close session details"
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
          <p className="mt-3 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
            {authorityNote(session)}
          </p>
          {session.error ? (
            <p className="mt-2 break-words rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-destructive">
              {session.error.message}
              {session.error.detail ? ` — ${session.error.detail}` : ''}
            </p>
          ) : null}
          {session.exitCode !== null ? (
            <p className="mt-2 text-[10px] text-muted-foreground">
              Exit code <span className="font-mono">{session.exitCode}</span>
            </p>
          ) : null}
        </div>
        <div className="flex items-center border-t border-border px-4 py-2.5">
          <span className="text-[10px] text-muted-foreground">Direct session · not a task</span>
          <button
            type="button"
            className="ml-auto rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </aside>
    </div>
  )
}
