import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import type { GitStashDiffPayload, GitStashEntry } from '../../../shared/icode-api'
import type { FileDiffPayload } from '../../../shared/schemas/changes'
import { callApi } from '../lib/api'
import { splitStashPatch, type StashPatchFile } from '../review/stash-patch'
import UnifiedDiffView from './UnifiedDiffView'

type Props = {
  sessionId: string
  stash: GitStashEntry
  onClose: () => void
}

function statusLetter(file: StashPatchFile): string {
  switch (file.status) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    default:
      return 'M'
  }
}

/** Read-only file-by-file view of one stash. */
export default function StashDetailView({
  sessionId,
  stash,
  onClose
}: Props): React.JSX.Element {
  const [files, setFiles] = useState<StashPatchFile[]>([])
  const [truncated, setTruncated] = useState(false)
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setSelected(0)
    void (async (): Promise<void> => {
      const result = await callApi<GitStashDiffPayload>(
        window.icode.git.stashDiff({ sessionId, index: stash.index })
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
      setFiles(splitStashPatch(result.value.patch))
      setTruncated(result.value.truncated)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, stash.index])

  const file = files[Math.min(selected, files.length - 1)] ?? null
  const payload: FileDiffPayload | null =
    file === null
      ? null
      : {
          status: 'available',
          sessionId,
          path: file.path,
          oldPath: file.oldPath,
          fileStatus: file.status,
          patch: file.patch,
          truncated,
          truncatedReason: truncated ? 'bytes' : null,
          binary: file.binary,
          symlink: null,
          additions: null,
          deletions: null
        }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="scm-stash-detail">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="truncate font-mono text-[11px] text-foreground">{stash.ref}</span>
        <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">{stash.subject}</span>
        <button
          type="button"
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close stash"
          data-testid="scm-stash-close"
          onClick={onClose}
        >
          <X size={12} />
        </button>
      </div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
          <Loader2 size={12} className="mr-2 animate-spin" />
          Reading stash…
        </div>
      ) : error !== null ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="max-w-md text-center text-[11px] text-signal">{error}</p>
        </div>
      ) : files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
          This stash has no textual changes.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul className="w-[min(260px,38%)] shrink-0 overflow-y-auto border-r border-border">
            {files.map((entry, index) => (
              <li key={`${entry.path}-${String(index)}`}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 px-2 py-1.5 text-left ${
                    index === selected ? 'bg-muted/60' : 'hover:bg-muted/30'
                  }`}
                  data-testid={`scm-stash-file-${entry.path}`}
                  onClick={() => setSelected(index)}
                >
                  <span className="w-3 shrink-0 font-mono text-[9px] font-semibold text-muted-foreground">
                    {statusLetter(entry)}
                  </span>
                  <span className="truncate font-mono text-[10.5px] text-foreground">{entry.path}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0 flex-1">
            {payload !== null ? (
              <UnifiedDiffView
                path={file!.path}
                state={{ phase: 'ready', diff: payload }}
                onRetry={() => setSelected(selected)}
                scopeLabel="stash"
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
