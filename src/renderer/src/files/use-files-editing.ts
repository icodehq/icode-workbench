import {
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { callApi } from '../lib/api'
import type { FilesMutatePayload } from '../../../shared/icode-api'
import type { TreeRow } from './selection'
import type { TreeState } from './use-files-tree'
import type { EditorMode } from './use-session-editor'
import type { FileUndoEntry } from './undo-stack'
import { clearWorktreeFileIndex } from './file-index'
import { basenameOf, parentPathOf } from './file-paths'
import { checkEntryName, nameSelectionRange } from './name-validation'
import { isGitMetadata, unavailableText } from './search-utils'
import { openFilesStore } from './open-files'
import { translate } from '../i18n/i18n-store'
import type { useT } from '../i18n/use-i18n'
import type { Notice } from '../state/workspace'

export type InlineEdit =
  | { kind: 'rename'; path: string; initial: string }
  | { kind: 'create-file'; parent: string }
  | { kind: 'create-directory'; parent: string }

export function useFilesEditing(input: {
  sessionId: string
  /** Worktree tab identity; defaults to the session for task panes. */
  scopeKey?: string
  notify: (notice: Notice) => void
  t: ReturnType<typeof useT>
  setTree: Dispatch<SetStateAction<TreeState>>
  tree: TreeState
  loadDirectory: (path: string, quiet?: boolean) => Promise<void>
  findEntry: (path: string) => { name: string; kind: 'file' | 'directory' } | null
  siblingsOf: (parent: string) => string[]
  selectOnly: (path: string) => void
  pushUndoEntry: (entry: FileUndoEntry) => void
  undoLast: () => Promise<void>
  openPath: (path: string, line?: number) => Promise<void>
  reloadExpanded: (quiet?: boolean, discover?: boolean) => Promise<void>
  setEditorMode: Dispatch<SetStateAction<EditorMode>>
  rowsRef: MutableRefObject<TreeRow[]>
  scrollRowIndexIntoView: (index: number) => void
  focusRowElement: (path: string) => void
}) {
  const {
    sessionId,
    scopeKey = sessionId,
    notify,
    t,
    setTree,
    tree,
    loadDirectory,
    findEntry,
    siblingsOf,
    selectOnly,
    pushUndoEntry,
    undoLast,
    openPath,
    reloadExpanded,
    setEditorMode,
    rowsRef,
    scrollRowIndexIntoView,
    focusRowElement
  } = input

  const [edit, setEdit] = useState<InlineEdit | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [editWarning, setEditWarning] = useState<string | null>(null)
  const editInput = useRef<HTMLInputElement | null>(null)
  const ignoreEditBlur = useRef(false)

  const beginCreate = (kind: 'create-file' | 'create-directory', parent: string): void => {
    ignoreEditBlur.current = false
    setEdit({ kind, parent })
    setEditValue('')
    setEditError(null)
    setEditWarning(null)
    if (parent !== '') {
      setTree((current) => ({
        ...current,
        expanded: { ...current.expanded, [parent]: true }
      }))
      if (tree.children[parent] === undefined) void loadDirectory(parent)
    }
    window.requestAnimationFrame(() => editInput.current?.focus())
  }

  const beginRename = (path: string): void => {
    const entry = findEntry(path)
    if (entry === null || isGitMetadata(path)) return
    ignoreEditBlur.current = false
    setEdit({ kind: 'rename', path, initial: entry.name })
    setEditValue(entry.name)
    setEditError(null)
    setEditWarning(null)
    window.requestAnimationFrame(() => {
      const input = editInput.current
      if (input === null) return
      input.focus()
      const [start, end] = nameSelectionRange(entry.name, entry.kind === 'directory')
      input.setSelectionRange(start, end)
    })
  }

  const cancelEdit = (): void => {
    ignoreEditBlur.current = true
    setEdit(null)
    setEditValue('')
    setEditError(null)
    setEditWarning(null)
  }

  const commitEdit = async (): Promise<void> => {
    if (edit === null) return
    const value = editValue
    const parent = edit.kind === 'rename' ? parentPathOf(edit.path) : edit.parent
    const previousName = edit.kind === 'rename' ? basenameOf(edit.path) : undefined
    const check = checkEntryName(value, {
      siblings: siblingsOf(parent),
      ...(previousName === undefined ? {} : { previousName })
    })
    setEditWarning(check.warning)
    if (check.error !== null) {
      setEditError(check.error)
      return
    }
    setEditError(null)

    if (edit.kind === 'rename') {
      if (value === edit.initial) {
        cancelEdit()
        return
      }
      const to = parent === '' ? value : `${parent}/${value}`
      if (isGitMetadata(edit.path) || isGitMetadata(to)) {
        setEditError(translate('files.gitMetadataRename'))
        return
      }
      const result = await callApi<FilesMutatePayload>(
        window.icode.files.rename({ sessionId, from: edit.path, to })
      )
      if (!result.ok) {
        setEditError(result.error.message)
        return
      }
      if (result.value.status === 'unavailable') {
        setEditError(unavailableText(result.value))
        return
      }
      openFilesStore.renamePath(scopeKey, edit.path, to)
      selectOnly(to)
      cancelEdit()
      pushUndoEntry({ kind: 'rename', from: edit.path, to, at: Date.now() })
      notify({
        tone: 'success',
        message: t('files.notice.renamed', { path: to }),
        action: { label: translate('files.undo'), run: () => void undoLast() }
      })
      clearWorktreeFileIndex(scopeKey)
      await reloadExpanded()
      window.requestAnimationFrame(() => {
        const index = rowsRef.current.findIndex((row) => row.entry.path === to)
        if (index !== -1) scrollRowIndexIntoView(index)
        focusRowElement(to)
      })
      return
    }

    const path = edit.parent === '' ? value : `${edit.parent}/${value}`
    if (isGitMetadata(path)) {
      setEditError(translate('files.gitMetadataCreate'))
      return
    }
    const kind = edit.kind === 'create-directory' ? 'directory' : 'file'
    const result = await callApi<FilesMutatePayload>(
      window.icode.files.create({ sessionId, path, kind })
    )
    if (!result.ok) {
      setEditError(result.error.message)
      return
    }
    if (result.value.status === 'unavailable') {
      setEditError(unavailableText(result.value))
      return
    }
    cancelEdit()
    pushUndoEntry({
      kind: 'create',
      path,
      etag: result.value.etag ?? null,
      at: Date.now()
    })
    notify({
      tone: 'success',
      message: `Created ${path}`,
      action: { label: translate('files.undo'), run: () => void undoLast() }
    })
    clearWorktreeFileIndex(scopeKey)
    await reloadExpanded()
    if (kind === 'file') {
      await openPath(path, 1)
    } else {
      selectOnly(path)
      setEditorMode('folder')
    }
  }

  return {
    edit,
    setEdit,
    editValue,
    setEditValue,
    editError,
    setEditError,
    editWarning,
    setEditWarning,
    editInput,
    ignoreEditBlur,
    beginCreate,
    beginRename,
    cancelEdit,
    commitEdit
  }
}
