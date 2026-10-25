import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, Search, X } from 'lucide-react'
import { callApi, errorNotice } from '../lib/api'
import type {
  FileContentPayload,
  FilesListingPayload,
  FileSearchPayload,
  FilesWritePayload,
  WorkspaceUnavailablePayload
} from '../../../shared/ade-api'
import type { FileEntry } from '../../../shared/domain/workspace-files'
import type { Notice } from '../state/workspace'
import CodeEditor from './CodeEditor'

export type FilesPanelProps = {
  sessionId: string
  /** Bumped when the user asks for a refresh of the whole workspace. */
  refreshToken: number
  notify: (notice: Notice) => void
  /** A file to open at a line, requested from search / quick open. */
  openRequest: { path: string; line: number; nonce: number } | null
  onOpenRequestHandled: () => void
}

type TreeState = {
  /** Expanded directories, as worktree-relative paths ('' is the root). */
  expanded: Record<string, boolean>
  children: Record<string, FileEntry[]>
  loading: Record<string, boolean>
}

const unavailableText = (payload: WorkspaceUnavailablePayload): string => {
  switch (payload.reason) {
    case 'worktree-unavailable':
      return 'This distro could not be reached, so its files are unavailable right now.'
    case 'worktree-missing':
      return 'The session worktree is missing.'
    case 'primary-checkout':
      return 'This session runs in the primary checkout, so it has no isolated file scope.'
    default:
      return payload.detail
  }
}

/**
 * Files, editor and search for one session's worktree.
 *
 * The panel owns no paths of its own: every call is scoped by `sessionId`, so
 * switching sessions cannot show another worktree's files. A search hit opens
 * the file at the matched line through the same editor instance.
 */
export default function FilesPanel({
  sessionId,
  refreshToken,
  notify,
  openRequest,
  onOpenRequestHandled
}: FilesPanelProps): React.JSX.Element {
  const [tree, setTree] = useState<TreeState>({ expanded: { '': true }, children: {}, loading: {} })
  const [rootState, setRootState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [rootNote, setRootNote] = useState('')
  const [openFile, setOpenFile] = useState<{ path: string; text: string; saved: string } | null>(null)
  const [fileNote, setFileNote] = useState('')
  const [gotoLine, setGotoLine] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<FileSearchPayload | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)

  const loadDirectory = useCallback(
    async (path: string): Promise<void> => {
      setTree((current) => ({ ...current, loading: { ...current.loading, [path]: true } }))
      const result = await callApi<FilesListingPayload>(
        window.ade.files.list({ sessionId, path })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        setTree((current) => {
          const loading = { ...current.loading }
          delete loading[path]
          return { ...current, loading }
        })
        return
      }
      const value = result.value
      if (value.status === 'unavailable') {
        if (path === '') {
          setRootState('unavailable')
          setRootNote(unavailableText(value))
        }
        setTree((current) => {
          const loading = { ...current.loading }
          delete loading[path]
          return { ...current, loading }
        })
        return
      }
      if (path === '') {
        setRootState('ready')
        setRootNote(value.truncated ? 'Showing the first 2000 entries.' : '')
      }
      setTree((current) => {
        const loading = { ...current.loading }
        delete loading[path]
        return {
          ...current,
          children: { ...current.children, [path]: value.entries },
          loading
        }
      })
    },
    [notify, sessionId]
  )

  // A different session means a different checkout: drop everything first.
  useEffect(() => {
    setTree({ expanded: { '': true }, children: {}, loading: {} })
    setOpenFile(null)
    setResults(null)
    setQuery('')
    setRootState('loading')
    setRootNote('')
    void loadDirectory('')
  }, [loadDirectory, sessionId, refreshToken])

  const openPath = useCallback(
    async (path: string, line = 1): Promise<void> => {
      setFileNote('')
      const result = await callApi<FileContentPayload>(window.ade.files.read({ sessionId, path }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      const value = result.value
      if (value.status === 'unavailable') {
        setOpenFile(null)
        setFileNote(unavailableText(value))
        return
      }
      if (value.binary) {
        setOpenFile(null)
        setFileNote('That file is binary, so it is not shown here.')
        return
      }
      if (value.tooLarge) {
        setOpenFile(null)
        setFileNote('That file is too large to open in the editor.')
        return
      }
      setOpenFile({ path: value.path, text: value.text, saved: value.text })
      setGotoLine(line)
    },
    [notify, sessionId]
  )

  // A request from search or quick open selects the file and reveals the line.
  useEffect(() => {
    if (!openRequest) return
    void openPath(openRequest.path, openRequest.line)
    onOpenRequestHandled()
  }, [onOpenRequestHandled, openPath, openRequest])

  const toggle = async (entry: FileEntry): Promise<void> => {
    if (entry.kind === 'file') {
      await openPath(entry.path, 1)
      return
    }
    const isOpen = tree.expanded[entry.path] === true
    setTree((current) => ({ ...current, expanded: { ...current.expanded, [entry.path]: !isOpen } }))
    if (!isOpen && tree.children[entry.path] === undefined) await loadDirectory(entry.path)
  }

  const runSearch = async (): Promise<void> => {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setResults(null)
      return
    }
    setSearching(true)
    const result = await callApi<FileSearchPayload>(
      window.ade.files.search({ sessionId, query: trimmed, caseSensitive: false, limit: 200 })
    )
    setSearching(false)
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    setResults(result.value)
  }

  const save = async (): Promise<void> => {
    if (!openFile) return
    const result = await callApi<FilesWritePayload>(
      window.ade.files.write({ sessionId, path: openFile.path, text: openFile.text })
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    if (result.value.status === 'unavailable') {
      notify({ tone: 'error', message: unavailableText(result.value) })
      return
    }
    setOpenFile({ ...openFile, saved: openFile.text })
    notify({ tone: 'success', message: `Saved ${openFile.path}` })
    // The change may now appear in Git and Changes; refresh the tree quietly.
    void loadDirectory('')
  }

  const dirty = openFile !== null && openFile.text !== openFile.saved
  const showSearch = query.trim().length > 0

  const renderEntries = (path: string, depth: number): React.JSX.Element[] => {
    const entries = tree.children[path] ?? []
    return entries.flatMap((entry) => {
      const isOpen = tree.expanded[entry.path] === true
      const rows: React.JSX.Element[] = [
        <button
          key={entry.path}
          type="button"
          className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-muted/60 ${
            openFile?.path === entry.path ? 'bg-muted text-foreground' : 'text-muted-foreground'
          }`}
          style={{ paddingLeft: `${String(depth * 12 + 4)}px` }}
          onClick={() => void toggle(entry)}
          data-testid={`files-entry-${entry.path}`}
          title={entry.path}
        >
          <span className="w-3 shrink-0 text-[9px]">
            {entry.kind === 'directory' ? (isOpen ? '▾' : '▸') : ''}
          </span>
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {tree.loading[entry.path] ? <span className="text-[9px]">…</span> : null}
        </button>
      ]
      if (entry.kind === 'directory' && isOpen) rows.push(...renderEntries(entry.path, depth + 1))
      return rows
    })
  }

  return (
    <div className="flex min-h-0 flex-1" data-testid="files-panel">
      <div className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <Search size={11} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchInput}
            value={query}
            placeholder="Search in files"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
            data-testid="files-search-input"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runSearch()
              if (event.key === 'Escape') {
                setQuery('')
                setResults(null)
              }
            }}
          />
          {query.length > 0 ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setQuery('')
                setResults(null)
              }}
              data-testid="files-search-clear"
              title="Clear search"
            >
              <X size={11} />
            </button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
          {rootState === 'loading' ? (
            <p className="px-2 py-1 text-[10px] text-muted-foreground">Loading…</p>
          ) : null}
          {rootState === 'unavailable' ? (
            <p className="px-2 py-1 text-[10px] text-amber-400" data-testid="files-unavailable">
              {rootNote}
            </p>
          ) : null}

          {showSearch ? (
            <div data-testid="files-search-results">
              <p className="px-1 py-1 text-[9px] text-muted-foreground" data-testid="files-search-summary">
                {searching
                  ? 'Searching…'
                  : results === null || results.status === 'unavailable'
                    ? 'Press Enter to search'
                    : `${String(results.matches.length)} match(es) in ${String(results.scannedFiles)} file(s)${
                        results.truncated ? ' · truncated' : ''
                      }`}
              </p>
              {results !== null && results.status === 'ok'
                ? results.matches.map((match, index) => (
                    <button
                      key={`${match.path}:${String(match.line)}:${String(index)}`}
                      type="button"
                      className="block w-full rounded px-1 py-0.5 text-left hover:bg-muted/60"
                      onClick={() => void openPath(match.path, match.line)}
                      data-testid={`files-search-hit-${match.path}-${String(match.line)}`}
                    >
                      <span className="block truncate font-mono text-[10px] text-foreground">
                        {match.path}:{match.line}
                      </span>
                      <span className="block truncate font-mono text-[9px] text-muted-foreground">
                        {match.text}
                      </span>
                    </button>
                  ))
                : null}
              {results !== null && results.status === 'unavailable' ? (
                <p className="px-1 py-1 text-[10px] text-amber-400">
                  {unavailableText(results)}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              {rootState === 'ready' ? (
                <div className="mb-1 flex items-center gap-1 px-1 text-[9px] text-muted-foreground">
                  <FolderOpen size={9} />
                  <span className="truncate">{rootNote || 'worktree root'}</span>
                </div>
              ) : null}
              {renderEntries('', 0)}
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {fileNote ? (
          <p className="border-b border-border px-3 py-2 text-[10px] text-amber-400" data-testid="files-file-note">
            {fileNote}
          </p>
        ) : null}
        {openFile ? (
          <CodeEditor
            path={openFile.path}
            value={openFile.text}
            dirty={dirty}
            gotoLine={gotoLine}
            onChange={(next) => setOpenFile({ ...openFile, text: next })}
            onSave={() => void save()}
            onClose={() => setOpenFile(null)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground" data-testid="files-empty">
              Pick a file to read or edit it here. Saved edits land in this session's worktree, so the
              Agent and the Changes review see them immediately.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
