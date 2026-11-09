import { useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyScore } from '../files/fuzzy'
import { getWorktreeFileIndex } from '../files/file-index'
import type { FileEntry } from '../../../shared/domain/workspace-files'
import type { Notice } from '../state/workspace'
import { useT, useTp } from '../i18n/use-i18n'

export type QuickOpenProps = {
  open: boolean
  sessionId: string
  notify: (notice: Notice) => void
  onClose: () => void
  /** Opens the chosen file; the optional line is 1 by default. */
  onOpen: (path: string, line: number) => void
}

/**
 * Splits `path:line` into its parts.
 *
 * Orca's palette accepts a line suffix, and the same shorthand is how a search
 * hit or a compiler message is usually pasted. A colon is only treated as a line
 * marker when what follows is a positive integer, so a Windows-style drive or a
 * file legitimately named `a:1` is left alone unless unambiguous.
 */
export function splitLineSuffix(query: string): { path: string; line: number | null } {
  const match = /^(.*):(\d+)$/u.exec(query.trim())
  if (match === null) return { path: query.trim(), line: null }
  const line = Number.parseInt(match[2] ?? '', 10)
  if (!Number.isFinite(line) || line < 1) return { path: query.trim(), line: null }
  return { path: match[1] ?? '', line }
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
  const t = useT()
  const tp = useTp()
  const [files, setFiles] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [indexed, setIndexed] = useState(false)
  const [active, setActive] = useState(0)
  const [note, setNote] = useState('')
  const input = useRef<HTMLInputElement | null>(null)

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
    void getWorktreeFileIndex(sessionId, notify).then((result) => {
      if (cancelled) return
      setFiles(result.files)
      setNote(result.note ?? '')
      setIndexed(true)
    })
    return () => {
      cancelled = true
    }
  }, [indexed, notify, open, sessionId])

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  const requestedLine = useMemo(() => splitLineSuffix(query).line, [query])

  const matches = useMemo(() => {
    if (!indexed) return []
    const wanted = splitLineSuffix(query).path
    if (wanted.length === 0) return files.slice(0, 50)
    const scored: Array<{ path: string; score: number }> = []
    for (const path of files) {
      const score = fuzzyScore(path, wanted)
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
      <div className="w-[640px] overflow-hidden rounded-xl border border-line-strong bg-card shadow-[var(--icode-shadow-overlay)]">
        <input
          ref={input}
          value={query}
          placeholder={
            indexed ? t('quickOpen.goToFile') : t('quickOpen.indexing')
          }
          className="w-full border-b border-border bg-transparent px-4 py-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
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
                onOpen(chosen, requestedLine ?? 1)
                onClose()
              }
            }
          }}
        />
        <div className="max-h-96 overflow-auto py-1.5" data-testid="quick-open-results">
          {note ? <p className="px-4 py-2 text-[11px] text-signal">{note}</p> : null}
          {!note && indexed && matches.length === 0 ? (
            <p className="px-4 py-2 text-[11px] text-muted-foreground">{t('quickOpen.noMatch')}</p>
          ) : null}
          {matches.map((path, index) => (
            <button
              key={path}
              type="button"
              className={`flex w-full items-center px-4 py-1.5 text-left font-mono text-[12px] ${
                index === active ? 'bg-muted text-foreground' : 'text-muted-foreground'
              }`}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                onOpen(path, requestedLine ?? 1)
                onClose()
              }}
              data-testid={`quick-open-hit-${path}`}
            >
              <span className="truncate">{path}</span>
            </button>
          ))}
        </div>
        <p className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
          {indexed
            ? tp('quickOpen.filesInWorktree', files.length)
            : t('quickOpen.reading')}
          {requestedLine === null ? '' : t('quickOpen.opensAt', { line: requestedLine })}
          {t('quickOpen.footer')}
        </p>
      </div>
    </div>
  )
}

/** Exported for the renderer test: entries are only files, never directories. */
export type { FileEntry }
