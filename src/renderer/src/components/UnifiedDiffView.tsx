import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ReviewDiffPayload } from '../../../shared/schemas/review'
import { collapseContext, parseUnifiedDiff, type DiffHunk } from '../review/parse-unified-diff'
import type { ReviewFileState } from '../review/review-state'

type Props = {
  path: string
  state: ReviewFileState
  onRetry: () => void
}

/**
 * A truncated diff can still contain hundreds of thousands of lines. Rendering
 * them all freezes the window, so only the first slice is mounted; the banner
 * above already states that the change is incomplete.
 */
const MAX_RENDERED_LINES = 1500

function HunkView({ hunk, index }: { hunk: DiffHunk; index: number }): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const rows = useMemo(() => collapseContext(hunk, 2, index), [hunk, index])

  return (
    <div data-testid="diff-hunk">
      <div className="sticky-none flex items-center gap-2 bg-muted/40 px-3 py-1 font-mono text-[10px] text-muted-foreground">
        <span>{hunk.header}</span>
      </div>
      {rows.map((row, rowIndex) => {
        if (row.kind === 'line') {
          const line = row.line
          const tone =
            line.kind === 'add'
              ? 'bg-emerald-500/10 text-emerald-200'
              : line.kind === 'remove'
                ? 'bg-red-500/10 text-red-200'
                : line.kind === 'meta'
                  ? 'text-muted-foreground italic'
                  : 'text-foreground/90'
          const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
          return (
            <div key={`${String(index)}-${String(rowIndex)}`} className={`flex ${tone}`}>
              <span className="w-10 shrink-0 select-none border-r border-border/50 px-1 text-right font-mono text-[9px] text-muted-foreground">
                {line.oldLine ?? ''}
              </span>
              <span className="w-10 shrink-0 select-none border-r border-border/50 px-1 text-right font-mono text-[9px] text-muted-foreground">
                {line.newLine ?? ''}
              </span>
              <span className="w-3 shrink-0 select-none text-center font-mono text-[10px] opacity-60">
                {line.kind === 'meta' ? ' ' : marker}
              </span>
              <span className="whitespace-pre pr-3 font-mono text-[11px] leading-[1.55]">
                {line.text}
                {line.crlf ? <span className="ml-1 text-[8px] text-muted-foreground">CRLF</span> : null}
              </span>
            </div>
          )
        }
        const isOpen = expanded.has(row.id)
        return (
          <div key={row.id}>
            <button
              type="button"
              className="flex w-full items-center gap-1 border-y border-border/40 bg-muted/20 px-3 py-1 text-left font-mono text-[10px] text-muted-foreground hover:bg-muted/40"
              onClick={() =>
                setExpanded((previous) => {
                  const next = new Set(previous)
                  if (next.has(row.id)) next.delete(row.id)
                  else next.add(row.id)
                  return next
                })
              }
              data-testid="diff-expand-context"
            >
              {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {isOpen ? 'Hide' : 'Show'} {row.count} unchanged line{row.count === 1 ? '' : 's'}
            </button>
            {isOpen
              ? row.lines.map((line, lineIndex) => (
                  <div
                    key={`${row.id}-${String(lineIndex)}`}
                    className="flex text-foreground/70"
                  >
                    <span className="w-10 shrink-0 border-r border-border/50 px-1 text-right font-mono text-[9px] text-muted-foreground">
                      {line.oldLine ?? ''}
                    </span>
                    <span className="w-10 shrink-0 border-r border-border/50 px-1 text-right font-mono text-[9px] text-muted-foreground">
                      {line.newLine ?? ''}
                    </span>
                    <span className="w-3 shrink-0" />
                    <span className="whitespace-pre pr-3 font-mono text-[11px] leading-[1.55]">
                      {line.text}
                    </span>
                  </div>
                ))
              : null}
          </div>
        )
      })}
    </div>
  )
}

export default function UnifiedDiffView({ path, state, onRetry }: Props): React.JSX.Element {
  if (state.phase === 'loading' || state.phase === 'idle') {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
        Loading diff…
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-md border border-destructive/40 bg-card p-4">
          <p className="text-[12px] font-medium text-destructive">The diff could not be read</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{state.error.message}</p>
          {state.error.detail ? (
            <p className="mt-1 break-words font-mono text-[10px] text-muted-foreground">
              {state.error.detail}
            </p>
          ) : null}
          <button
            type="button"
            className="mt-3 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
            onClick={onRetry}
            data-testid="review-diff-retry"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }
  return <DiffBody path={path} diff={state.diff} />
}

function DiffBody({ path, diff }: { path: string; diff: ReviewDiffPayload }): React.JSX.Element {
  const parsed = useMemo(() => parseUnifiedDiff(diff.patch), [diff.patch])
  const totalLines = parsed.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  const omitted = Math.max(0, totalLines - MAX_RENDERED_LINES)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={`review-diff-${path}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="truncate font-mono text-[10px] text-foreground/90">
          {diff.oldPath ? `${diff.oldPath} → ${diff.path}` : diff.path}
        </span>
        <span className="rounded-sm border border-border px-1 text-[9px] uppercase text-muted-foreground">
          {diff.fileStatus}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {diff.additions === null ? '—' : `+${String(diff.additions)}`}{' '}
          {diff.deletions === null ? '' : `−${String(diff.deletions)}`}
        </span>
      </div>

      {diff.truncated ? (
        <div
          className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-200"
          data-testid="review-diff-truncated"
        >
          This diff is incomplete: Git output exceeded the {diff.truncatedReason === 'timeout' ? 'time limit' : '2 MiB view limit'}.
          Open the session terminal if you need the full change.
        </div>
      ) : null}

      {diff.symlink ? (
        <div className="shrink-0 border-b border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
          This entry is a symbolic link. The diff shows the link target, never the target file's contents.
        </div>
      ) : null}

      {diff.binary ? (
        <div className="flex flex-1 items-center justify-center p-6" data-testid="review-diff-binary">
          <div className="text-center">
            <p className="text-[12px] font-medium">Binary file</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Git cannot show a text diff for this file. Nothing else is read.
            </p>
          </div>
        </div>
      ) : parsed.hunks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-[11px] text-muted-foreground">
          Git returned no textual changes for this file.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto font-mono" data-testid="review-diff-body">
          {(() => {
            let remaining = MAX_RENDERED_LINES
            const rendered: React.JSX.Element[] = []
            for (const [index, hunk] of parsed.hunks.entries()) {
              if (remaining <= 0) break
              const visibleHunk =
                hunk.lines.length <= remaining
                  ? hunk
                  : { ...hunk, lines: hunk.lines.slice(0, remaining) }
              remaining -= visibleHunk.lines.length
              rendered.push(
                <HunkView
                  key={`${String(index)}-${hunk.header}`}
                  hunk={visibleHunk}
                  index={index}
                />
              )
            }
            return rendered
          })()}
          {omitted > 0 ? (
            <div
              className="border-t border-border bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground"
              data-testid="review-diff-render-cap"
            >
              Showing the first {MAX_RENDERED_LINES.toLocaleString()} of {totalLines.toLocaleString()}{' '}
              lines. Open the session terminal to inspect the rest.
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
