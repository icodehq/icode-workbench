import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FilePlus2,
  FolderOpen,
  FolderPlus,
  History,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { callApi, errorNotice } from '../lib/api'
import type {
  FileContentPayload,
  FilesListingPayload,
  FileSearchPayload,
  FilesMutatePayload,
  FilesWritePayload,
  GitFileAtRevisionPayload,
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
  /** Opens Source Control History filtered to the open file. */
  onOpenHistory?: (path: string) => void
  /** `monaco` opts into the bundled editor; the default keeps the textarea. */
  editorEngine?: 'monaco' | 'plain'
}

type TreeState = {
  /** Expanded directories, as worktree-relative paths ('' is the root). */
  expanded: Record<string, boolean>
  children: Record<string, FileEntry[]>
  loading: Record<string, boolean>
}

/** The one-line description shown above the operation's input. */
function pendingLabel(pending: NonNullable<PendingFilesOperation>): string {
  switch (pending.kind) {
    case 'create-file':
      return `New file in ${pending.parent === '' ? 'the worktree root' : pending.parent}`
    case 'create-directory':
      return `New folder in ${pending.parent === '' ? 'the worktree root' : pending.parent}`
    case 'rename':
      return `Rename ${pending.from}`
    case 'delete':
      return `Delete ${pending.path}${pending.isDirectory ? ' and everything inside it' : ''}`
  }
}

type PendingFilesOperation =
  | { kind: 'create-file'; parent: string }
  | { kind: 'create-directory'; parent: string }
  | { kind: 'rename'; from: string }
  | { kind: 'delete'; path: string; isDirectory: boolean }

const parentPathOf = (path: string): string => {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/** Rename accepts a path so it can move an entry inside the worktree. */
function worktreePathError(value: string): string | null {
  if (value.length === 0) return 'A path is required.'
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) {
    return 'Use a path relative to the worktree.'
  }
  if (value.includes('\u0000')) return 'That path is not valid.'
  if (value.includes('\\')) return 'Use / separators in the path.'
  if (value.startsWith('-')) return 'A path cannot start with a dash.'
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'Use a normalized path without empty, . or .. segments.'
  }
  return null
}

function plainNameError(value: string): string | null {
  if (value.length === 0) return 'A name is required.'
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    return 'Use a plain name. Rename with a path to move an entry.'
  }
  return null
}

/** The worktree's Git link is plumbing, not a file to browse or edit. */
const isGitMetadata = (path: string): boolean => path.split('/').includes('.git')

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
  onOpenRequestHandled,
  onOpenHistory,
  editorEngine = 'plain'
}: FilesPanelProps): React.JSX.Element {
  const [tree, setTree] = useState<TreeState>({ expanded: { '': true }, children: {}, loading: {} })
  const [rootState, setRootState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [rootNote, setRootNote] = useState('')
  const [openFile, setOpenFile] = useState<{
    path: string
    text: string
    saved: string
    /** HEAD text for quick diff; null for a new/untracked/binary/large file. */
    original: string | null
  } | null>(null)
  const [fileNote, setFileNote] = useState('')
  const [gotoLine, setGotoLine] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<FileSearchPayload | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  /**
   * One pending file operation at a time.
   *
   * A single inline row is enough for create/rename, and it keeps the target
   * visible next to the tree instead of in a modal that hides the context.
   */
  const [pending, setPending] = useState<PendingFilesOperation | null>(null)
  const [pendingValue, setPendingValue] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

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
    setSelected(null)
    setPending(null)
    setPendingValue('')
    void loadDirectory('')
  }, [loadDirectory, sessionId, refreshToken])

  const openPath = useCallback(
    async (path: string, line = 1): Promise<void> => {
      setFileNote('')
      if (isGitMetadata(path)) {
        setOpenFile(null)
        setFileNote('Git metadata is managed by Git and is not editable here.')
        return
      }
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
      const openedPath = value.path
      setOpenFile({ path: openedPath, text: value.text, saved: value.text, original: null })
      setSelected(openedPath)
      setGotoLine(line)
      void callApi<GitFileAtRevisionPayload>(
        window.ade.git.fileAtRevision({ sessionId, rev: 'HEAD', path: openedPath })
      ).then((baseline) => {
        const original =
          baseline.ok &&
          baseline.value.status === 'ok' &&
          !baseline.value.binary &&
          !baseline.value.tooLarge
            ? baseline.value.text
            : null
        setOpenFile((current) =>
          current !== null && current.path === openedPath ? { ...current, original } : current
        )
      })
    },
    [notify, sessionId]
  )

  // A request from search or quick open selects the file and reveals the line.
  useEffect(() => {
    if (!openRequest) return
    void openPath(openRequest.path, openRequest.line)
    onOpenRequestHandled()
  }, [onOpenRequestHandled, openPath, openRequest])

  /**
   * Reloads every expanded directory that could have changed.
   *
   * Re-reading only the affected parent would leave a renamed path's old row in
   * a collapsed branch; re-reading the expanded set keeps the visible tree true
   * while leaving collapsed branches lazy.
   */
  const reloadExpanded = useCallback(async (): Promise<void> => {
    const paths = Object.keys(tree.expanded).filter((path) => tree.expanded[path] === true)
    await Promise.all(paths.map((path) => loadDirectory(path)))
  }, [loadDirectory, tree.expanded])

  const runPending = async (): Promise<void> => {
    if (!pending) return
    const value = pendingValue.trim()
    const close = (): void => {
      setPending(null)
      setPendingValue('')
    }

    if (pending.kind === 'delete' && isGitMetadata(pending.path)) {
      notify({ tone: 'error', message: 'Git metadata is managed by Git and cannot be deleted here.' })
      return
    }

    if (pending.kind === 'delete') {
      const result = await callApi<FilesMutatePayload>(
        window.ade.files.remove({ sessionId, path: pending.path })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: unavailableText(result.value) })
        return
      }
      if (openFile?.path === pending.path || openFile?.path.startsWith(`${pending.path}/`)) setOpenFile(null)
      if (selected === pending.path || selected?.startsWith(`${pending.path}/`)) setSelected(null)
      close()
      notify({ tone: 'success', message: `Deleted ${pending.path}` })
      await reloadExpanded()
      return
    }

    if (pending.kind === 'rename') {
      const problem = worktreePathError(value)
      if (problem) {
        notify({ tone: 'error', message: problem })
        return
      }
      if (isGitMetadata(pending.from) || isGitMetadata(value)) {
        notify({ tone: 'error', message: 'Git metadata cannot be renamed or moved here.' })
        return
      }
      const to = value
      if (to === pending.from) return close()
      const result = await callApi<FilesMutatePayload>(
        window.ade.files.rename({ sessionId, from: pending.from, to })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: unavailableText(result.value) })
        return
      }
      if (openFile?.path === pending.from) {
        setOpenFile({ ...openFile, path: to, original: null })
      } else if (openFile?.path.startsWith(`${pending.from}/`)) {
        setOpenFile({
          ...openFile,
          path: `${to}/${openFile.path.slice(pending.from.length + 1)}`,
          original: null
        })
      }
      if (selected === pending.from) {
        setSelected(to)
      } else if (selected?.startsWith(`${pending.from}/`)) {
        setSelected(`${to}/${selected.slice(pending.from.length + 1)}`)
      }
      close()
      notify({ tone: 'success', message: `Renamed to ${to}` })
      await reloadExpanded()
      return
    }

    const problem = plainNameError(value)
    if (problem) {
      notify({ tone: 'error', message: problem })
      return
    }

    const path = pending.parent === '' ? value : `${pending.parent}/${value}`
    if (isGitMetadata(path)) {
      notify({ tone: 'error', message: 'Git metadata cannot be created here.' })
      return
    }
    const kind = pending.kind === 'create-directory' ? 'directory' : 'file'
    const result = await callApi<FilesMutatePayload>(
      window.ade.files.create({ sessionId, path, kind })
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    if (result.value.status === 'unavailable') {
      notify({ tone: 'error', message: unavailableText(result.value) })
      return
    }
    close()
    notify({ tone: 'success', message: `Created ${path}` })
    await reloadExpanded()
    if (kind === 'file') await openPath(path, 1)
  }

  const toggle = async (entry: FileEntry): Promise<void> => {
    setSelected(entry.path)
    if (entry.kind === 'file') {
      await openPath(entry.path, 1)
      return
    }
    // Selecting a folder shows its panel, but never drops an unsaved edit.
    const unsaved = openFile !== null && openFile.text !== openFile.saved
    if (!unsaved) setOpenFile(null)
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

  /** Finds a loaded entry by path, for the operations that need its kind. */
  const findEntry = (path: string): FileEntry | null => {
    for (const entries of Object.values(tree.children)) {
      const found = entries.find((entry) => entry.path === path)
      if (found) return found
    }
    return null
  }

  const selectedEntry = selected === null ? null : findEntry(selected)

  const renderEntries = (path: string, depth: number): React.JSX.Element[] => {
    const entries = tree.children[path] ?? []
    return entries.flatMap((entry) => {
      if (isGitMetadata(entry.path)) return []
      const isOpen = tree.expanded[entry.path] === true
      const rows: React.JSX.Element[] = [
        <button
          key={entry.path}
          type="button"
          className={`flex h-7 w-full items-center gap-1 rounded px-1.5 text-left text-[11.5px] hover:bg-muted/60 ${
            selected === entry.path ? 'bg-accent/10 text-foreground shadow-[inset_2px_0_0_var(--ade-accent)]' : 'text-muted-foreground'
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
      <div className="flex w-[312px] shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <Search size={11} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchInput}
            value={query}
            placeholder="Search in files"
            className="min-w-0 flex-1 bg-transparent text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground"
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

        <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1 py-1">
          {(
            [
              ['create-file', FilePlus2, 'New file', 'files-new-file'],
              ['create-directory', FolderPlus, 'New folder', 'files-new-directory'],
              ['rename', Pencil, 'Rename', 'files-rename'],
              ['delete', Trash2, 'Delete', 'files-delete']
            ] as const
          ).map(([action, Icon, title, testId]) => {
            const target = selected ?? ''
            // Creating is always available: the destination is the selection, or
            // the root when nothing is selected. Only the operations that need a
            // target are disabled without one.
            const disabled =
              action === 'create-file' || action === 'create-directory' ? false : target.length === 0
            return (
              <button
                key={action}
                type="button"
                className={`inline-flex h-7 items-center gap-1 rounded px-2 text-[10.5px] hover:bg-muted hover:text-foreground disabled:opacity-30 ${
                  action === 'delete' && !disabled
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                }`}
                title={title}
                disabled={disabled}
                data-testid={testId}
                onClick={() => {
                  setPendingValue('')
                  if (action === 'create-file' || action === 'create-directory') {
                    // New entries go beside the selection: inside it for a folder.
                    const selectedEntry = selected === null ? null : findEntry(selected)
                    const parent =
                      selectedEntry?.kind === 'directory' ? (selected ?? '') : parentPathOf(selected ?? '')
                    setPending({ kind: action, parent })
                    return
                  }
                  if (action === 'rename') {
                    setPending({ kind: 'rename', from: target })
                    setPendingValue(target)
                  }
                  if (action === 'delete') {
                    const entry = findEntry(target)
                    setPending({ kind: 'delete', path: target, isDirectory: entry?.kind === 'directory' })
                  }
                }}
              >
                <Icon size={10} />
                {title}
              </button>
            )
          })}
          <button
            type="button"
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Refresh the tree"
            aria-label="Refresh tree"
            data-testid="files-refresh"
            onClick={() => void reloadExpanded()}
          >
            <RefreshCw size={11} />
          </button>
        </div>

        <div
          className="border-b border-border bg-card px-3 py-1.5 text-[10px] text-muted-foreground"
          data-testid="files-selection"
        >
          {selected === null ? (
            'Select a file or folder to rename or delete it.'
          ) : (
            <>
              Selected{' '}
              <span className="font-mono text-foreground" title={selected}>
                {selected}
              </span>{' '}
              · {selectedEntry?.kind === 'directory' ? 'folder' : 'file'}
            </>
          )}
        </div>

        {pending ? (
          <div className="border-b border-border px-2 py-1.5" data-testid="files-pending">
            <p className="mb-1 text-[9px] text-muted-foreground" data-testid="files-pending-label">
              {pendingLabel(pending)}
            </p>
            {pending.kind === 'delete' ? null : (
              <input
                autoFocus
                value={pendingValue}
                placeholder={
                  pending.kind === 'rename'
                    ? 'src/auth/session.ts'
                    : pending.kind === 'create-directory'
                      ? 'New folder name'
                      : 'New file name'
                }
                className="w-full rounded border border-border bg-transparent px-1 py-0.5 font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
                data-testid="files-pending-input"
                onChange={(event) => setPendingValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runPending()
                  if (event.key === 'Escape') {
                    setPending(null)
                    setPendingValue('')
                  }
                }}
              />
            )}
            <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
              {pending.kind === 'rename'
                ? 'Rename or move. Use a path such as src/auth/session.ts.'
                : pending.kind === 'delete'
                  ? 'Deletes in the worktree; Git history is unchanged.'
                  : 'Use a plain name; the entry is created in the selected folder.'}
            </p>
            <div className="mt-1 flex items-center gap-1">
              <button
                type="button"
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  pending.kind === 'delete'
                    ? 'border border-destructive/60 text-destructive hover:bg-destructive/10'
                    : 'border border-border text-foreground hover:bg-muted'
                }`}
                data-testid="files-pending-confirm"
                onClick={() => void runPending()}
              >
                {pending.kind === 'delete' ? 'Delete' : 'Confirm'}
              </button>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                data-testid="files-pending-cancel"
                onClick={() => {
                  setPending(null)
                  setPendingValue('')
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
          {rootState === 'loading' ? (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">Loading…</p>
          ) : null}
          {rootState === 'unavailable' ? (
            <p className="px-2 py-1 text-[11px] text-signal" data-testid="files-unavailable">
              {rootNote}
            </p>
          ) : null}

          {showSearch ? (
            <div data-testid="files-search-results">
              <p className="px-1 py-1 text-[10px] text-muted-foreground" data-testid="files-search-summary">
                {searching
                  ? 'Searching…'
                  : results === null || results.status === 'unavailable'
                    ? 'Press Enter to search'
                    : `${String(results.matches.length)} match(es) in ${String(results.scannedFiles)} file(s)${
                        results.truncated ? ' · truncated' : ''
                      }`}
              </p>
              {results !== null && results.status === 'ok'
                ? results.matches
                    .filter((match) => !isGitMetadata(match.path))
                    .map((match, index) => (
                    <button
                      key={`${match.path}:${String(match.line)}:${String(index)}`}
                      type="button"
                      className="block w-full rounded px-1 py-0.5 text-left hover:bg-muted/60"
                      onClick={() => void openPath(match.path, match.line)}
                      data-testid={`files-search-hit-${match.path}-${String(match.line)}`}
                    >
                      <span className="block truncate font-mono text-[11px] text-foreground">
                        {match.path}:{match.line}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {match.text}
                      </span>
                    </button>
                  ))
                : null}
              {results !== null && results.status === 'unavailable' ? (
                <p className="px-1 py-1 text-[10px] text-signal">
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
          <p className="border-b border-border px-3 py-2 text-[10px] text-signal" data-testid="files-file-note">
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
            onHistory={onOpenHistory ? () => onOpenHistory(openFile.path) : undefined}
            engine={editorEngine}
            original={openFile.original}
            onQuickDiffChanged={(text) =>
              setOpenFile({ ...openFile, text, saved: text })
            }
            sessionId={sessionId}
          />
        ) : selectedEntry?.kind === 'directory' ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4">
              <h2 className="text-[13px] font-semibold">{selectedEntry.name}</h2>
              <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                {selectedEntry.path}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Rename and Delete act on this selected folder. A rename path can move it elsewhere in
                the worktree.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {onOpenHistory ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
                    data-testid="files-folder-history"
                    onClick={() => onOpenHistory(selectedEntry.path)}
                  >
                    <History size={10} />
                    History
                  </button>
                ) : null}
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
                  data-testid="files-folder-rename"
                  onClick={() => {
                    setPending({ kind: 'rename', from: selectedEntry.path })
                    setPendingValue(selectedEntry.path)
                  }}
                >
                  <Pencil size={10} />
                  Rename or move
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-destructive/60 px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10"
                  data-testid="files-folder-delete"
                  onClick={() =>
                    setPending({ kind: 'delete', path: selectedEntry.path, isDirectory: true })
                  }
                >
                  <Trash2 size={10} />
                  Delete folder…
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <p className="max-w-sm text-[11.5px] leading-relaxed text-muted-foreground" data-testid="files-empty">
              Pick a file to read or edit it here. Saved edits land in this session's worktree, so the
              Agent and the Changes review see them immediately.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
