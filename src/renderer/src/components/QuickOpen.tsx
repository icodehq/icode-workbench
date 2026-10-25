import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { callApi, errorNotice } from '../lib/api'
import type { FilesListingPayload } from '../../../shared/ade-api'
import type { FileEntry } from '../../../shared/domain/workspace-files'
import type { Notice } from '../state/workspace'

export type QuickOpenProps = {
  open: boolean
  sessionId: string
  notify: (notice: Notice) => void
  onClose: () => void
  /** Opens the chosen file; the optional line is 1 by default. */
  onOpen: (path: string, line: number) => void
}

const MAX_FILES = 5000

/**
 * Scores a fuzzy subsequence match, higher is better; null means no match.
 *
 * Deliberately the classic filename behaviour: characters must appear in order,
 * a contiguous run at a path-segment start scores best, and the basename counts
 * double so "panl" finds `components/FilesPanel.tsx` rather than a longer path
 * that happens to contain the letters.
 */
export function fuzzyScore(candidate: string, query: string): number | null {
  if (query.length === 0) return 0
  const haystack = candidate.toLowerCase()
  const needle = query.toLowerCase()

  let score = 0
  let cursor = 0
  let lastMatch = -2
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor)
    if (found === -1) return null
    const contiguous = found === lastMatch + 1
    const atSegmentStart = found === 0 || haystack[found - 1] === '/'
    const inBasename = found >= haystack.lastIndexOf('/') + 1
    score += 1
    if (contiguous) score += 4
    if (atSegmentStart) score += 6
    if (inBasename) score += 3
    lastMatch = found
    cursor = found + 1
  }
  // Prefer shorter paths when the match quality ties.
  return score - Math.min(candidate.length, 200) / 100
}

/**
 * Ctrl/Cmd+P file navigation.
 *
 * The file index is built once per session from the worktree listing, so typing
 * costs nothing after the first open. Switching sessions drops the index, which
 * is what keeps one worktree's paths out of another's palette.
 */
export default function QuickOpen({
  open,
  sessionId,
  notify,
  onClose,
  onOpen
}: QuickOpenProps): React.JSX.Element | null {
  const [files, setFiles] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [indexed, setIndexed] = useState(false)
  const [active, setActive] = useState(0)
  const [note, setNote] = useState('')
  const input = useRef<HTMLInputElement | null>(null)

  const walk = useCallback(
    async (path: string, collected: string[]): Promise<boolean> => {
      const result = await callApi<FilesListingPayload>(window.ade.files.list({ sessionId, path }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      const value = result.value
      if (value.status === 'unavailable') {
        setNote(
          value.reason === 'worktree-unavailable'
            ? 'This distro could not be reached, so file navigation is unavailable.'
            : value.detail
        )
        return false
      }
      for (const entry of value.entries) {
        if (collected.length >= MAX_FILES) return false
        if (entry.kind === 'file') collected.push(entry.path)
        else if (!SKIP.has(entry.name)) {
          const ok = await walk(entry.path, collected)
          if (!ok) return false
        }
      }
      return true
    },
    [notify, sessionId]
  )

  useEffect(() => {
    setFiles([])
    setIndexed(false)
    setQuery('')
    setNote('')
    setActive(0)
  }, [sessionId])

  useEffect(() => {
    if (!open || indexed) return
    let cancelled = false
    const collected: string[] = []
    void walk('', collected).then(() => {
      if (cancelled) return
      setFiles(collected)
      setIndexed(true)
    })
    return () => {
      cancelled = true
    }
  }, [indexed, open, walk])

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  const matches = useMemo(() => {
    if (!indexed) return []
    if (query.trim().length === 0) return files.slice(0, 50)
    const scored: Array<{ path: string; score: number }> = []
    for (const path of files) {
      const score = fuzzyScore(path, query.trim())
      if (score !== null) scored.push({ path, score })
    }
    scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    return scored.slice(0, 50).map((entry) => entry.path)
  }, [files, indexed, query])

  useEffect(() => {
    setActive(0)
  }, [query])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      data-testid="quick-open"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="w-[520px] overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        <input
          ref={input}
          value={query}
          placeholder={indexed ? 'Go to file…' : 'Indexing worktree…'}
          className="w-full border-b border-border bg-transparent px-3 py-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
          data-testid="quick-open-input"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive((current) => Math.min(current + 1, Math.max(matches.length - 1, 0)))
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((current) => Math.max(current - 1, 0))
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              const chosen = matches[active]
              if (chosen) {
                onOpen(chosen, 1)
                onClose()
              }
            }
          }}
        />
        <div className="max-h-80 overflow-auto py-1" data-testid="quick-open-results">
          {note ? <p className="px-3 py-2 text-[10px] text-amber-400">{note}</p> : null}
          {!note && indexed && matches.length === 0 ? (
            <p className="px-3 py-2 text-[10px] text-muted-foreground">No file matches that.</p>
          ) : null}
          {matches.map((path, index) => (
            <button
              key={path}
              type="button"
              className={`flex w-full items-center px-3 py-1 text-left font-mono text-[11px] ${
                index === active ? 'bg-muted text-foreground' : 'text-muted-foreground'
              }`}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                onOpen(path, 1)
                onClose()
              }}
              data-testid={`quick-open-hit-${path}`}
            >
              <span className="truncate">{path}</span>
            </button>
          ))}
        </div>
        <p className="border-t border-border px-3 py-1 text-[9px] text-muted-foreground">
          {indexed ? `${String(files.length)} file(s) in this worktree` : 'reading the worktree…'} · Enter opens ·
          Esc closes
        </p>
      </div>
    </div>
  )
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', 'target', '__pycache__', '.venv'])

/** Exported for the renderer test: entries are only files, never directories. */
export type { FileEntry }
