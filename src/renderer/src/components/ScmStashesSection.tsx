import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react'
import type {
  GitStashActionPayload,
  GitStashEntry,
  GitStashListPayload,
  GitStashPushPayload
} from '../../../shared/icode-api'
import { callApi } from '../lib/api'
import type { Notice } from '../state/workspace'

type Props = {
  sessionId: string
  /** Global refresh and the watcher revision both reload the list. */
  refreshToken: number
  gitRevision: number
  notify: (notice: Notice) => void
  onChanged: () => void
  onOpenStash: (stash: GitStashEntry) => void
}

export default function ScmStashesSection({
  sessionId,
  refreshToken,
  gitRevision,
  notify,
  onChanged,
  onOpenStash
}: Props): React.JSX.Element {
  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [compose, setCompose] = useState(false)
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [keepIndex, setKeepIndex] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    void (async (): Promise<void> => {
      const result = await callApi<GitStashListPayload>(
        window.icode.git.stashList({ sessionId })
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
      setStashes(result.value.stashes)
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

  const create = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('create')
    setError(null)
    try {
      const result = await callApi<GitStashPushPayload>(
        window.icode.git.stashPush({
          sessionId,
          message,
          includeUntracked,
          keepIndex
        })
      )
      if (!result.ok) {
        notify({ tone: 'error', message: result.error.message })
        return
      }
      if (result.value.status !== 'ok') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      if (!result.value.created) {
        notify({ tone: 'info', message: 'There are no changes to stash.' })
        return
      }
      notify({ tone: 'success', message: 'Stashed changes' })
      setCompose(false)
      setMessage('')
      setIncludeUntracked(false)
      setKeepIndex(false)
      reload()
    } finally {
      setBusy(null)
    }
  }

  const act = async (action: 'apply' | 'pop' | 'drop', index: number): Promise<void> => {
    if (busy !== null) return
    setBusy(`${action}:${String(index)}`)
    setError(null)
    try {
      const result = await callApi<GitStashActionPayload>(
        window.icode.git.stashAction({ sessionId, index, action })
      )
      if (!result.ok) {
        notify({ tone: 'error', message: result.error.message })
        return
      }
      if (result.value.status !== 'ok') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({
        tone: 'success',
        message: `${action === 'apply' ? 'Applied' : action === 'pop' ? 'Popped' : 'Dropped'} ${result.value.ref}`
      })
      setDropIndex(null)
      reload()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="border-t border-border" aria-label="Stashes" data-testid="scm-stashes">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={collapsed ? 'Expand Stashes' : 'Collapse Stashes'}
          aria-expanded={!collapsed}
          data-testid="scm-stashes-toggle"
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
        <span className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          Stashes
        </span>
        <span className="font-mono text-[9px] text-muted-foreground">{stashes.length}</span>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground"
          data-testid="scm-stash-toggle-compose"
          onClick={() => setCompose((value) => !value)}
        >
          <Plus size={9} />
          Stash
        </button>
      </div>

      {compose ? (
        <div className="space-y-1.5 border-t border-border px-2 py-2" data-testid="scm-stash-compose">
          <input
            value={message}
            placeholder="Stash message"
            className="h-6 w-full rounded border border-border bg-transparent px-1.5 text-[10px] text-foreground outline-none focus:border-signal"
            data-testid="scm-stash-message"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
            }}
          />
          <label className="flex items-center gap-1.5 text-[9.5px] text-muted-foreground">
            <input
              type="checkbox"
              checked={includeUntracked}
              data-testid="scm-stash-untracked"
              onChange={(event) => setIncludeUntracked(event.target.checked)}
            />
            Include untracked
          </label>
          <label className="flex items-center gap-1.5 text-[9.5px] text-muted-foreground">
            <input
              type="checkbox"
              checked={keepIndex}
              data-testid="scm-stash-keep-index"
              onChange={(event) => setKeepIndex(event.target.checked)}
            />
            Keep staged changes
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded border border-signal-line bg-signal px-2 py-0.5 text-[9.5px] text-white hover:brightness-95 disabled:opacity-50"
              disabled={busy !== null}
              data-testid="scm-stash-create"
              onClick={() => void create()}
            >
              {busy === 'create' ? 'Stashing…' : 'Stash Changes'}
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[9.5px] text-muted-foreground hover:text-foreground"
              onClick={() => setCompose(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {!collapsed ? (
        <div className="pb-1">
          {loading ? (
            <p className="flex items-center gap-1.5 px-3 py-1.5 text-[9.5px] text-muted-foreground">
              <Loader2 size={9} className="animate-spin" />
              Reading stashes…
            </p>
          ) : error !== null ? (
            <p className="px-3 py-1.5 text-[9.5px] text-destructive">{error}</p>
          ) : stashes.length === 0 ? (
            <p className="px-3 py-1.5 text-[9.5px] text-muted-foreground">No stashes.</p>
          ) : (
            <ul>
              {stashes.map((stash) => (
                <li
                  key={stash.ref}
                  className="border-t border-border/40 px-1 py-1"
                  data-testid={`scm-stash-row-${String(stash.index)}`}
                >
                  <div className="flex items-start gap-1">
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded px-1 py-0.5 text-left hover:bg-muted/40"
                      data-testid={`scm-stash-open-${String(stash.index)}`}
                      onClick={() => onOpenStash(stash)}
                    >
                      <span className="block truncate text-[10px] text-foreground">{stash.subject}</span>
                      <span className="block truncate font-mono text-[8.5px] text-muted-foreground">
                        {stash.ref} · {stash.date}
                      </span>
                    </button>
                    <span className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        className="rounded px-1 py-0.5 text-[8.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                        disabled={busy !== null}
                        data-testid={`scm-stash-apply-${String(stash.index)}`}
                        onClick={() => void act('apply', stash.index)}
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        className="rounded px-1 py-0.5 text-[8.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                        disabled={busy !== null}
                        data-testid={`scm-stash-pop-${String(stash.index)}`}
                        onClick={() => void act('pop', stash.index)}
                      >
                        Pop
                      </button>
                      <button
                        type="button"
                        className="rounded px-1 py-0.5 text-[8.5px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
                        disabled={busy !== null}
                        data-testid={`scm-stash-drop-${String(stash.index)}`}
                        onClick={() => setDropIndex(stash.index)}
                      >
                        Drop
                      </button>
                    </span>
                  </div>
                  {dropIndex === stash.index ? (
                    <div className="mt-1 flex items-center gap-1 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-1">
                      <span className="text-[9px] text-destructive">Drop this stash?</span>
                      <span className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          className="rounded border border-destructive bg-destructive px-1.5 py-0.5 text-[8.5px] text-white disabled:opacity-50"
                          disabled={busy !== null}
                          data-testid={`scm-stash-drop-yes-${String(stash.index)}`}
                          onClick={() => void act('drop', stash.index)}
                        >
                          Drop
                        </button>
                        <button
                          type="button"
                          className="rounded px-1 py-0.5 text-[8.5px] text-muted-foreground hover:text-foreground"
                          data-testid={`scm-stash-drop-cancel-${String(stash.index)}`}
                          onClick={() => setDropIndex(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  )
}
