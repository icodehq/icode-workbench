import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type { GitCheckoutRefPayload, GitTagsPayload } from '../../../shared/icode-api'
import type { GitTag } from '../../../shared/domain/git-workspace'
import { callApi } from '../lib/api'
import type { Notice } from '../state/workspace'

type Props = {
  sessionId: string
  refreshToken: number
  gitRevision: number
  notify: (notice: Notice) => void
  onChanged: () => void
}

export default function ScmTagsSection({
  sessionId,
  refreshToken,
  gitRevision,
  notify,
  onChanged
}: Props): React.JSX.Element {
  const [tags, setTags] = useState<GitTag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmTag, setConfirmTag] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    void (async (): Promise<void> => {
      const result = await callApi<GitTagsPayload>(
        window.icode.git.tags({ sessionId })
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
      setTags(result.value.tags)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [gitRevision, refreshToken, reloadTick, sessionId])

  const checkout = async (tag: string): Promise<void> => {
    if (busy !== null) return
    setBusy(tag)
    setError(null)
    try {
      const result = await callApi<GitCheckoutRefPayload>(
        window.icode.git.checkoutRef({ sessionId, ref: tag })
      )
      if (!result.ok) {
        notify({ tone: 'error', message: result.error.message })
        return
      }
      if (result.value.status !== 'ok') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `Checked out tag ${tag}` })
      setConfirmTag(null)
      setReloadTick((value) => value + 1)
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="border-t border-border" aria-label="Tags" data-testid="scm-tags">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={collapsed ? 'Expand Tags' : 'Collapse Tags'}
          aria-expanded={!collapsed}
          data-testid="scm-tags-toggle"
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
        <span className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tags
        </span>
        <span className="font-mono text-[9px] text-muted-foreground">{tags.length}</span>
      </div>

      {!collapsed ? (
        loading ? (
          <p className="flex items-center gap-1.5 px-3 py-1.5 text-[9.5px] text-muted-foreground">
            <Loader2 size={9} className="animate-spin" />
            Reading tags…
          </p>
        ) : error !== null ? (
          <p className="px-3 py-1.5 text-[9.5px] text-destructive">{error}</p>
        ) : tags.length === 0 ? (
          <p className="px-3 py-1.5 text-[9.5px] text-muted-foreground">No tags.</p>
        ) : (
          <ul className="pb-1">
            {tags.map((tag) => (
              <li
                key={tag.name}
                className="border-t border-border/40 px-1 py-1"
                data-testid={`scm-tag-row-${tag.name}`}
              >
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate px-1 font-mono text-[10px] text-foreground">
                    {tag.name}
                  </span>
                  <span className="shrink-0 font-mono text-[8.5px] text-muted-foreground">
                    {tag.oid.slice(0, 8)}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded px-1 py-0.5 text-[8.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                    disabled={busy !== null}
                    data-testid={`scm-tag-checkout-${tag.name}`}
                    onClick={() => setConfirmTag(tag.name)}
                  >
                    Checkout
                  </button>
                </div>
                {confirmTag === tag.name ? (
                  <div className="mt-1 flex items-center gap-1 rounded border border-signal-line bg-signal-weak px-1.5 py-1">
                    <span className="text-[9px] text-signal">
                      Check out {tag.name} detached?
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        className="rounded border border-signal-line bg-signal px-1.5 py-0.5 text-[8.5px] text-white disabled:opacity-50"
                        disabled={busy !== null}
                        data-testid={`scm-tag-checkout-yes-${tag.name}`}
                        onClick={() => void checkout(tag.name)}
                      >
                        {busy === tag.name ? 'Checking out…' : 'Checkout'}
                      </button>
                      <button
                        type="button"
                        className="rounded px-1 py-0.5 text-[8.5px] text-muted-foreground hover:text-foreground"
                        data-testid={`scm-tag-checkout-cancel-${tag.name}`}
                        onClick={() => setConfirmTag(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
}
