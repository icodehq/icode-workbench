import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type {
  GitSubmoduleActionPayload,
  GitSubmoduleInfo,
  GitSubmoduleListPayload
} from '../../../shared/ade-api'
import { callApi } from '../lib/api'
import type { Notice } from '../state/workspace'

type Props = {
  sessionId: string
  refreshToken: number
  gitRevision: number
  notify: (notice: Notice) => void
  onChanged: () => void
}

const STATE_LABEL: Record<GitSubmoduleInfo['state'], string> = {
  clean: 'clean',
  uninitialized: 'not initialized',
  modified: 'pointer changed',
  conflict: 'conflict'
}

export default function ScmSubmodulesSection({
  sessionId,
  refreshToken,
  gitRevision,
  notify,
  onChanged
}: Props): React.JSX.Element {
  const [submodules, setSubmodules] = useState<GitSubmoduleInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    void (async (): Promise<void> => {
      const result = await callApi<GitSubmoduleListPayload>(
        window.ade.git.submoduleList({ sessionId })
      )
      if (cancelled) return
      if (!result.ok) {
        setError(result.error.message)
        setLoading(false)
        return
      }
      if (result.value.status !== 'ok') {
        setError(result.value.detail)
        setLoading(false)
        return
      }
      setSubmodules(result.value.submodules)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [gitRevision, refreshToken, reloadTick, sessionId])

  const reload = (): void => {
    setReloadTick((value) => value + 1)
    onChanged()
  }

  const act = async (
    action: 'init' | 'update' | 'sync' | 'stage',
    path: string
  ): Promise<void> => {
    if (busy !== null) return
    setBusy(`${action}:${path}`)
    setError(null)
    try {
      const result = await callApi<GitSubmoduleActionPayload>(
        window.ade.git.submoduleAction({ sessionId, action, path })
      )
      if (!result.ok) {
        notify({ tone: 'error', message: result.error.message })
        return
      }
      if (result.value.status !== 'ok') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      const past =
        action === 'init'
          ? 'Initialized'
          : action === 'update'
            ? 'Updated'
            : action === 'sync'
              ? 'Synced'
              : 'Staged'
      notify({ tone: 'success', message: `${past} ${path}` })
      reload()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="border-t border-border" aria-label="Submodules" data-testid="scm-submodules">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={collapsed ? 'Expand Submodules' : 'Collapse Submodules'}
          aria-expanded={!collapsed}
          data-testid="scm-submodules-toggle"
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
        <span className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          Submodules
        </span>
        <span className="font-mono text-[9px] text-muted-foreground">{submodules.length}</span>
      </div>

      {!collapsed ? (
        loading ? (
          <p className="flex items-center gap-1.5 px-3 py-1.5 text-[9.5px] text-muted-foreground">
            <Loader2 size={9} className="animate-spin" />
            Reading submodules…
          </p>
        ) : error !== null ? (
          <p className="px-3 py-1.5 text-[9.5px] text-destructive">{error}</p>
        ) : submodules.length === 0 ? (
          <p className="px-3 py-1.5 text-[9.5px] text-muted-foreground">No submodules.</p>
        ) : (
          <ul className="pb-1">
            {submodules.map((entry) => (
              <li
                key={entry.path}
                className="border-t border-border/40 px-1 py-1"
                data-testid={`scm-submodule-row-${entry.path}`}
              >
                <div className="flex items-start gap-1">
                  <div className="min-w-0 flex-1 px-1 py-0.5">
                    <span className="block truncate font-mono text-[10px] text-foreground">
                      {entry.path}
                    </span>
                    <span className="block truncate font-mono text-[8.5px] text-muted-foreground">
                      {entry.oid.slice(0, 8)}
                      {entry.branch ? ` · ${entry.branch}` : ''}
                    </span>
                  </div>
                  <span
                    className={`shrink-0 rounded border px-1 py-0.5 text-[8px] uppercase ${
                      entry.state === 'clean'
                        ? 'border-border text-muted-foreground'
                        : entry.state === 'conflict'
                          ? 'border-destructive/40 text-destructive'
                          : 'border-signal-line text-signal'
                    }`}
                  >
                    {STATE_LABEL[entry.state]}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1 px-1">
                  {entry.state === 'uninitialized' ? (
                    <button
                      type="button"
                      className="rounded border border-border px-1 py-0.5 text-[8.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                      disabled={busy !== null}
                      data-testid={`scm-submodule-init-${entry.path}`}
                      onClick={() => void act('init', entry.path)}
                    >
                      Init
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="rounded border border-border px-1 py-0.5 text-[8.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                    disabled={busy !== null}
                    data-testid={`scm-submodule-update-${entry.path}`}
                    onClick={() => void act('update', entry.path)}
                  >
                    Update
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border px-1 py-0.5 text-[8.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                    disabled={busy !== null}
                    data-testid={`scm-submodule-sync-${entry.path}`}
                    onClick={() => void act('sync', entry.path)}
                  >
                    Sync
                  </button>
                  {entry.state === 'modified' || entry.state === 'conflict' ? (
                    <button
                      type="button"
                      className="rounded border border-signal-line bg-signal-weak px-1 py-0.5 text-[8.5px] text-signal hover:brightness-95 disabled:opacity-40"
                      disabled={busy !== null}
                      data-testid={`scm-submodule-stage-${entry.path}`}
                      onClick={() => void act('stage', entry.path)}
                    >
                      Stage Pointer
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
}
