import { useCallback, useEffect, useState } from 'react'
import { callApi } from '../../lib/api'
import type {
  GitFileAtRevisionPayload,
  GitRevisionFileDiffPayload
} from '../../../../shared/icode-api'
import type { GitRangeFile } from '../../../../shared/domain/git-workspace'
import { makeAppError } from '../../../../shared/domain/errors'
import UnifiedDiffView, { type DiffViewState } from '../UnifiedDiffView'
import MonacoDiffView from '../MonacoDiffView'
import { commitFilePayload, statusLetter, statusTone } from './HistoryViewParts'

type Props = {
  sessionId: string
  baseOid: string
  file: GitRangeFile
}

type Sides = { original: string; modified: string }

function readText(
  result: Awaited<ReturnType<typeof callApi<GitFileAtRevisionPayload>>>,
  allowMissing: boolean
): string | null {
  if (!result.ok) return null
  const value = result.value
  if (value.status !== 'ok') return allowMissing ? '' : null
  if (value.binary || value.tooLarge) return null
  return value.text
}

/**
 * Read-only diff for one file committed between the session baseline and HEAD.
 *
 * Working-tree rows keep `WorkingDiffView` (hunk actions, notes). Committed
 * rows are a finished slice of the session, so they use the same read-only
 * revision renderer as History and never expose stage or discard actions.
 */
export default function CommittedFileDiff({
  sessionId,
  baseOid,
  file
}: Props): React.JSX.Element {
  const [state, setState] = useState<DiffViewState>({ phase: 'loading' })
  const [sides, setSides] = useState<Sides | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setState({ phase: 'loading' })
    setSides(null)
    const originalPath = file.oldPath ?? file.path
    const [diff, originalRead, modifiedRead] = await Promise.all([
      callApi<GitRevisionFileDiffPayload>(
        window.icode.git.revisionFileDiff({
          sessionId,
          from: baseOid,
          to: 'HEAD',
          path: file.path,
          ...(file.oldPath === null ? {} : { oldPath: file.oldPath })
        })
      ),
      callApi<GitFileAtRevisionPayload>(
        window.icode.git.fileAtRevision({ sessionId, rev: baseOid, path: originalPath })
      ),
      callApi<GitFileAtRevisionPayload>(
        window.icode.git.fileAtRevision({ sessionId, rev: 'HEAD', path: file.path })
      )
    ])

    if (!diff.ok) {
      setState({ phase: 'error', error: diff.error })
      return
    }
    if (diff.value.status === 'unavailable') {
      setState({ phase: 'error', error: makeAppError('GIT_READ_FAILED', diff.value.detail) })
      return
    }

    const original = readText(originalRead, file.status === 'added')
    const modified = readText(modifiedRead, file.status === 'deleted')
    if (original !== null && modified !== null) setSides({ original, modified })
    setState({ phase: 'ready', diff: commitFilePayload(sessionId, file, diff.value) })
  }, [baseOid, file, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const retry = (): void => {
    void load()
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="scm-committed-diff">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <span
          className={`w-3 shrink-0 text-center font-mono text-[10px] font-semibold ${statusTone(file.status)}`}
        >
          {statusLetter(file.status)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
          {file.oldPath === null ? '' : `${file.oldPath} → `}
          {file.path}
        </span>
        <span className="shrink-0 rounded-full border border-info/40 bg-info-weak px-1.5 py-0.5 text-[9px] text-info">
          committed
        </span>
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
          since {baseOid.slice(0, 7)}
        </span>
        {file.binary ? (
          <span className="shrink-0 rounded bg-muted px-1 text-[8.5px] text-muted-foreground">
            binary
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
            +{file.additions ?? 0} −{file.deletions ?? 0}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {sides === null ? (
          <UnifiedDiffView
            path={file.path}
            state={state}
            onRetry={retry}
            scopeLabel={`since ${baseOid.slice(0, 7)}`}
          />
        ) : (
          <MonacoDiffView
            path={file.path}
            original={sides.original}
            modified={sides.modified}
            fallback={
              <UnifiedDiffView
                path={file.path}
                state={state}
                onRetry={retry}
                scopeLabel={`since ${baseOid.slice(0, 7)}`}
              />
            }
          />
        )}
      </div>
    </div>
  )
}
