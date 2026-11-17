import {
  useCallback,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { callApi, errorNotice } from '../lib/api'
import type {
  FilesBatchPayload,
  FilesCopyPathsPayload,
  FilesListingPayload,
  FilesMutatePayload,
  FilesRestoreTrashPayload,
  FilesStatPayload,
  FilesTrashListPayload,
  FilesTrashPayload
} from '../../../shared/icode-api'
import type { FileBatchEntry, FileEntry } from '../../../shared/domain/workspace-files'
import { clearWorktreeFileIndex } from './file-index'
import { isUnder, parentPathOf } from './file-paths'
import { filesClipboardStore } from './files-clipboard'
import { openFilesStore } from './open-files'
import {
  EMPTY_SELECTION,
  collapseSelectedPaths,
  type SelectionState
} from './selection'
import {
  peekUndo,
  popUndo,
  pushUndo,
  type FileUndoEntry
} from './undo-stack'
import { unavailableText } from './search-utils'
import { translate, translatePlural } from '../i18n/i18n-store'
import type { useT, useTp } from '../i18n/use-i18n'
import type { Notice } from '../state/workspace'
import type { EditorMode } from './use-files-tabs'

export type DeletePrompt = { paths: string[]; permanentOnly: boolean }
export type MovePrompt = { paths: string[]; destination: string }

export function useFilesOperations(input: {
  sessionId: string
  useTrash: boolean
  notify: (notice: Notice) => void
  t: ReturnType<typeof useT>
  tp: ReturnType<typeof useTp>
  selectedPaths: () => string[]
  selectOnly: (path: string) => void
  setSelection: Dispatch<SetStateAction<SelectionState>>
  setEditorMode: Dispatch<SetStateAction<EditorMode>>
  openPath: (path: string, line?: number) => Promise<void>
  findEntry: (path: string) => FileEntry | null
  expandFolder: (path: string) => Promise<void>
  reloadExpanded: (quiet?: boolean, discover?: boolean) => Promise<void>
  scheduleDecorationsRef: MutableRefObject<((delay?: number) => void) | null>
}) {
  const {
    sessionId,
    useTrash,
    notify,
    t,
    tp,
    selectedPaths,
    selectOnly,
    setSelection,
    setEditorMode,
    openPath,
    findEntry,
    expandFolder,
    reloadExpanded,
    scheduleDecorationsRef
  } = input

  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt | null>(null)
  const [movePrompt, setMovePrompt] = useState<MovePrompt | null>(null)
  const [undoStack, setUndoStack] = useState<FileUndoEntry[]>([])
  const [undoing, setUndoing] = useState(false)
  const [trashBanner, setTrashBanner] = useState<{
    opId: string
    paths: string[]
  } | null>(null)
  const [transferBusy, setTransferBusy] = useState(false)

  const refreshTrash = useCallback(async (): Promise<void> => {
    const result = await callApi<FilesTrashListPayload>(
      window.icode.files.listTrash({ sessionId })
    )
    if (!result.ok || result.value.status !== 'ok') {
      setTrashBanner(null)
      return
    }
    const latest = result.value.items[0]
    setTrashBanner(
      latest === undefined
        ? null
        : { opId: latest.opId, paths: latest.entries.map((entry) => entry.path) }
    )
  }, [sessionId])

  const pushUndoEntry = (entry: FileUndoEntry): void => {
    setUndoStack((current) => pushUndo(current, entry))
  }

  const closeTabsUnder = (paths: readonly string[]): void => {
    for (const path of paths) {
      for (const tab of openFilesStore.get(sessionId).tabs) {
        if (isUnder(tab.path, path)) openFilesStore.closeTab(sessionId, tab.path)
      }
    }
  }

  const restoreTrashOp = async (opId: string): Promise<boolean> => {
    setUndoing(true)
    const result = await callApi<FilesRestoreTrashPayload>(
      window.icode.files.restoreTrash({ sessionId, opId })
    )
    setUndoing(false)
    if (!result.ok) {
      notify(errorNotice(result.error))
      await refreshTrash()
      return false
    }
    if (result.value.status === 'unavailable') {
      notify({ tone: 'error', message: unavailableText(result.value) })
      await refreshTrash()
      return false
    }
    const failures = result.value.results.filter((entry) => !entry.ok)
    const successes = result.value.results.filter((entry) => entry.ok)
    if (failures.length === 0) {
      setUndoStack((current) =>
        current.filter((entry) => entry.kind !== 'delete' || entry.opId !== opId)
      )
      const first = successes[0]?.path
      if (first !== undefined) {
        selectOnly(first)
        setEditorMode(successes.length === 1 ? 'tab' : 'folder')
      }
      notify({
        tone: 'success',
        message: tp('files.notice.restored', successes.length)
      })
    } else {
      const first = failures[0]
      setSelection({
        selected: new Set(failures.map((entry) => entry.path)),
        anchor: first?.path ?? null,
        focused: first?.path ?? null
      })
      setEditorMode('folder')
      notify({
        tone: 'error',
        message: t('files.notice.restoredSummary', {
          restored: successes.length,
          failed: failures.length,
          detail: first?.detail ?? t('files.notice.unknownError')
        })
      })
    }
    clearWorktreeFileIndex(sessionId)
    await reloadExpanded()
    scheduleDecorationsRef.current?.(0)
    await refreshTrash()
    return failures.length === 0
  }

  const requestDelete = (
    paths: readonly string[],
    permanentOnly = false
  ): void => {
    const targets = collapseSelectedPaths(paths.filter((path) => path !== ''))
    if (targets.length === 0) return
    setDeletePrompt({ paths: targets, permanentOnly })
  }

  const confirmPermanentDelete = async (): Promise<void> => {
    if (deletePrompt === null) return
    setTransferBusy(true)
    const result = await callApi<FilesBatchPayload>(
      window.icode.files.removeMany({ sessionId, paths: deletePrompt.paths })
    )
    if (!result.ok) {
      setTransferBusy(false)
      notify(errorNotice(result.error))
      setDeletePrompt(null)
      return
    }
    if (result.value.status === 'unavailable') {
      setTransferBusy(false)
      notify({ tone: 'error', message: unavailableText(result.value) })
      setDeletePrompt(null)
      return
    }
    const successes = result.value.results.filter((entry) => entry.ok)
    const failures = result.value.results.filter((entry) => !entry.ok)
    closeTabsUnder(successes.map((entry) => entry.path))
    setDeletePrompt(null)
    if (failures.length === 0) {
      setSelection(EMPTY_SELECTION)
      setEditorMode('tab')
      notify({
        tone: 'success',
        message: tp('files.notice.deletedForever', successes.length)
      })
    } else {
      const first = failures[0]
      setSelection({
        selected: new Set(failures.map((entry) => entry.path)),
        anchor: first?.path ?? null,
        focused: first?.path ?? null
      })
      setEditorMode('folder')
      notify({
        tone: 'error',
        message: t('files.notice.deletedSummary', {
          deleted: successes.length,
          failed: failures.length,
          detail: first?.detail ?? t('files.notice.unknownError')
        })
      })
    }
    clearWorktreeFileIndex(sessionId)
    await reloadExpanded()
    scheduleDecorationsRef.current?.(0)
    setTransferBusy(false)
  }

  const confirmTrashDelete = async (): Promise<void> => {
    if (deletePrompt === null) return
    setTransferBusy(true)
    const result = await callApi<FilesTrashPayload>(
      window.icode.files.trashMany({ sessionId, paths: deletePrompt.paths })
    )
    if (!result.ok) {
      setTransferBusy(false)
      notify(errorNotice(result.error))
      setDeletePrompt(null)
      return
    }
    if (result.value.status === 'unavailable') {
      setTransferBusy(false)
      notify({ tone: 'error', message: unavailableText(result.value) })
      setDeletePrompt(null)
      return
    }
    const successes = result.value.entries.map((entry) => entry.path)
    const failures = result.value.results.filter((entry) => !entry.ok)
    closeTabsUnder(successes)
    setDeletePrompt(null)
    if (successes.length > 0) {
      if (result.value.opId !== null) {
        const opId = result.value.opId
        setTrashBanner({ opId, paths: successes })
        pushUndoEntry({
          kind: 'delete',
          opId,
          paths: successes,
          at: Date.now()
        })
        notify({
          tone: failures.length === 0 ? 'success' : 'info',
          message:
            tp('files.notice.trashed', successes.length) +
            (failures.length > 0
              ? ` · ${t('files.notice.failedCount', { count: failures.length })}`
              : ''),
          action: {
            label: translate('files.undo'),
            run: () => {
              void restoreTrashOp(opId)
            }
          }
        })
      }
    } else {
      notify({
        tone: 'error',
        message:
          failures[0]?.detail ?? translate('files.notice.trashFailed')
      })
    }
    if (failures.length > 0) {
      const first = failures[0]
      setSelection({
        selected: new Set(failures.map((entry) => entry.path)),
        anchor: first?.path ?? null,
        focused: first?.path ?? null
      })
      setEditorMode('folder')
    } else {
      setSelection(EMPTY_SELECTION)
      setEditorMode('tab')
    }
    clearWorktreeFileIndex(sessionId)
    await reloadExpanded()
    scheduleDecorationsRef.current?.(0)
    await refreshTrash()
    setTransferBusy(false)
  }

  const confirmDelete = async (): Promise<void> => {
    if (deletePrompt === null) return
    if (useTrash && !deletePrompt.permanentOnly) {
      await confirmTrashDelete()
    } else {
      await confirmPermanentDelete()
    }
  }

  const undoLast = async (): Promise<void> => {
    if (undoing || transferBusy) return
    const entry = peekUndo(undoStack)
    if (entry === null) {
      notify({ tone: 'info', message: translate('files.notice.nothingToUndo') })
      return
    }
    setUndoing(true)
    let ok = false
    let partial = false
    let detail = ''
    try {
      if (entry.kind === 'create') {
        const stat = await callApi<FilesStatPayload>(
          window.icode.files.stat({ sessionId, path: entry.path })
        )
        let safe = false
        if (!stat.ok) {
          detail = stat.error.message
        } else if (stat.value.status === 'unavailable') {
          if (stat.value.reason === 'not-found') safe = true
          else detail = unavailableText(stat.value)
        } else if (stat.value.kind === 'directory') {
          const listing = await callApi<FilesListingPayload>(
            window.icode.files.list({ sessionId, path: entry.path })
          )
          if (listing.ok && listing.value.status === 'ok') {
            safe = listing.value.entries.length === 0
            if (!safe) detail = translate('files.notice.newFolderHasFiles')
          } else if (!listing.ok) {
            detail = listing.error.message
          } else if (listing.value.status === 'unavailable') {
            detail = unavailableText(listing.value)
          }
        } else if (entry.etag === null) {
          detail = translate('files.notice.noRecordedVersion')
        } else if (stat.value.etag === entry.etag) {
          safe = true
        } else {
          detail = translate('files.notice.changedAfterCreate')
        }
        if (safe) {
          const result = await callApi<FilesBatchPayload>(
            window.icode.files.removeMany({ sessionId, paths: [entry.path] })
          )
          if (result.ok && result.value.status === 'ok') {
            ok = result.value.results.every((item) => item.ok)
            if (!ok) detail = result.value.results.find((item) => !item.ok)?.detail ?? ''
          } else if (!result.ok) {
            detail = result.error.message
          } else if (result.value.status === 'unavailable') {
            detail = unavailableText(result.value)
          }
        }
      } else if (entry.kind === 'rename') {
        const result = await callApi<FilesMutatePayload>(
          window.icode.files.rename({ sessionId, from: entry.to, to: entry.from })
        )
        if (result.ok && result.value.status === 'ok') {
          ok = true
          selectOnly(entry.from)
        } else {
          detail = !result.ok
            ? result.error.message
            : result.value.status === 'unavailable'
              ? unavailableText(result.value)
              : ''
        }
      } else if (entry.kind === 'move') {
        const failed: Array<{ from: string; to: string }> = []
        for (const pair of entry.pairs) {
          const result = await callApi<FilesMutatePayload>(
            window.icode.files.rename({
              sessionId,
              from: pair.to,
              to: pair.from
            })
          )
          if (!result.ok) {
            failed.push(pair)
            detail = result.error.message
          } else if (result.value.status === 'unavailable') {
            failed.push(pair)
            detail = unavailableText(result.value)
          }
        }
        if (failed.length === 0) ok = true
        else {
          partial = true
          setUndoStack((current) => [
            { ...entry, pairs: failed },
            ...current.slice(1)
          ])
        }
      } else if (entry.kind === 'copy') {
        const safe: string[] = []
        const unsafe: Array<{ path: string; etag: string | null }> = []
        for (const item of entry.created) {
          const stat = await callApi<FilesStatPayload>(
            window.icode.files.stat({ sessionId, path: item.path })
          )
          if (!stat.ok) {
            unsafe.push(item)
            detail = stat.error.message
          } else if (stat.value.status === 'unavailable') {
            if (stat.value.reason === 'not-found') continue
            unsafe.push(item)
            detail = unavailableText(stat.value)
          } else if (
            item.etag !== null &&
            stat.value.kind === 'file' &&
            stat.value.etag === item.etag
          ) {
            safe.push(item.path)
          } else {
            unsafe.push(item)
            detail = translate('files.notice.copyChanged')
          }
        }
        if (safe.length > 0) {
          const result = await callApi<FilesBatchPayload>(
            window.icode.files.removeMany({ sessionId, paths: safe })
          )
          if (result.ok && result.value.status === 'ok') {
            for (const item of result.value.results) {
              if (!item.ok) unsafe.push({ path: item.path, etag: null })
            }
          } else if (!result.ok) {
            detail = result.error.message
            for (const path of safe) unsafe.push({ path, etag: null })
          } else if (result.value.status === 'unavailable') {
            detail = unavailableText(result.value)
            for (const path of safe) unsafe.push({ path, etag: null })
          }
        }
        if (unsafe.length === 0) ok = true
        else {
          partial = true
          setUndoStack((current) => [
            { ...entry, created: unsafe },
            ...current.slice(1)
          ])
        }
      } else {
        const restored = await restoreTrashOp(entry.opId)
        if (!restored) {
          // restoreTrashOp reports the conflict and keeps the entry retryable.
          return
        }
        return
      }
    } finally {
      setUndoing(false)
    }
    if (ok) setUndoStack((current) => popUndo(current))
    clearWorktreeFileIndex(sessionId)
    await reloadExpanded()
    scheduleDecorationsRef.current?.(0)
    if (ok) {
      notify({ tone: 'success', message: translate('files.notice.undoneLast') })
    } else if (!partial) {
      notify({
        tone: 'error',
        message: t('files.notice.undoFailed', {
          detail: detail || t('files.notice.pathChanged')
        })
      })
    } else {
      notify({
        tone: 'info',
        message: t('files.notice.undoPartial', {
          detail: detail || t('files.notice.pathsUnchanged')
        })
      })
    }
  }

  const copySelection = (mode: 'copy' | 'cut', paths = selectedPaths()): void => {
    const targets = collapseSelectedPaths(paths.filter((path) => path !== ''))
    if (targets.length === 0) return
    filesClipboardStore.set({ sessionId, paths: targets, mode })
  }

  const collectEtags = async (
    paths: readonly string[]
  ): Promise<Array<{ path: string; etag: string | null }>> =>
    Promise.all(
      paths.map(async (path) => {
        const stat = await callApi<FilesStatPayload>(
          window.icode.files.stat({ sessionId, path })
        )
        return {
          path,
          etag:
            stat.ok && stat.value.status === 'ok' && stat.value.kind === 'file'
              ? stat.value.etag
              : null
        }
      })
    )

  const duplicateSelection = async (paths = selectedPaths()): Promise<void> => {
    const targets = collapseSelectedPaths(paths.filter((path) => path !== ''))
    if (targets.length === 0) {
      notify({ tone: 'info', message: translate('files.notice.duplicateSelect') })
      return
    }
    if (transferBusy) return
    setTransferBusy(true)
    const created: string[] = []
    let detail = ''
    for (const target of targets) {
      const result = await callApi<FilesBatchPayload>(
        window.icode.files.copyMany({
          sessionId,
          paths: [target],
          destination: parentPathOf(target)
        })
      )
      if (!result.ok) {
        detail = result.error.message
        continue
      }
      if (result.value.status === 'unavailable') {
        detail = unavailableText(result.value)
        continue
      }
      for (const entry of result.value.results) {
        if (entry.ok && entry.to !== undefined) created.push(entry.to)
        else if (!entry.ok && detail === '') detail = entry.detail ?? ''
      }
    }
    setTransferBusy(false)
    if (created.length === 0) {
      notify({
        tone: 'error',
        message: translate('files.notice.duplicateFailed', {
          detail: detail ? `: ${detail}` : ''
        })
      })
      return
    }
    pushUndoEntry({
      kind: 'copy',
      created: await collectEtags(created),
      at: Date.now()
    })
    clearWorktreeFileIndex(sessionId)
    await reloadExpanded()
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve())
    })
    setSelection({
      selected: new Set(created),
      anchor: created[0] ?? null,
      focused: created[0] ?? null
    })
    setEditorMode(created.length === 1 ? 'tab' : 'folder')
    notify({
      tone: 'success',
      message: tp('files.notice.duplicated', created.length),
      action: { label: translate('files.undo'), run: () => void undoLast() }
    })
  }

  const copyPathsToClipboard = async (
    format: 'absolute' | 'relative',
    paths: readonly string[]
  ): Promise<void> => {
    const targets = collapseSelectedPaths(paths.filter((path) => path !== ''))
    if (targets.length === 0) return
    const result = await callApi<FilesCopyPathsPayload>(
      window.icode.files.copyPaths({ sessionId, paths: targets, format })
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    if (result.value.status === 'unavailable') {
      notify({ tone: 'error', message: unavailableText(result.value) })
      return
    }
    notify({
      tone: 'success',
      message: tp('files.notice.copiedPaths', result.value.count)
    })
  }

  type TransferOutcome = {
    allOk: boolean
    succeeded: number
    failures: FileBatchEntry[]
  }

  const performTransfer = async (
    mode: 'copy' | 'move',
    paths: readonly string[],
    destination: string
  ): Promise<TransferOutcome> => {
    const targets = collapseSelectedPaths(paths.filter((path) => path !== ''))
    if (targets.length === 0) return { allOk: false, succeeded: 0, failures: [] }
    for (const target of targets) {
      if (destination === target || destination.startsWith(`${target}/`)) {
        notify({ tone: 'error', message: translate('files.notice.cannotIntoSelf') })
        return { allOk: false, succeeded: 0, failures: [] }
      }
    }
    const kinds = new Map<string, FileEntry['kind']>()
    for (const target of targets) {
      const entry = findEntry(target)
      if (entry !== null) kinds.set(target, entry.kind)
    }

    setTransferBusy(true)
    const result = await callApi<FilesBatchPayload>(
      mode === 'move'
        ? window.icode.files.moveMany({ sessionId, paths: targets, destination })
        : window.icode.files.copyMany({ sessionId, paths: targets, destination })
    )
    if (!result.ok) {
      setTransferBusy(false)
      notify(errorNotice(result.error))
      return { allOk: false, succeeded: 0, failures: [] }
    }
    if (result.value.status === 'unavailable') {
      setTransferBusy(false)
      notify({ tone: 'error', message: unavailableText(result.value) })
      return { allOk: false, succeeded: 0, failures: [] }
    }

    const successes = result.value.results.filter((entry) => entry.ok && !entry.skipped)
    const failures = result.value.results.filter((entry) => !entry.ok)
    if (successes.length > 0) {
      if (mode === 'move') {
        pushUndoEntry({
          kind: 'move',
          pairs: successes.flatMap((entry) =>
            entry.from !== undefined && entry.to !== undefined
              ? [{ from: entry.from, to: entry.to }]
              : []
          ),
          at: Date.now()
        })
      } else {
        pushUndoEntry({
          kind: 'copy',
          created: await collectEtags(
            successes.flatMap((entry) =>
              entry.to === undefined ? [] : [entry.to]
            )
          ),
          at: Date.now()
        })
      }
    }
    if (mode === 'move') {
      for (const entry of successes) {
        if (entry.from !== undefined && entry.to !== undefined) {
          openFilesStore.renamePath(sessionId, entry.from, entry.to)
        }
      }
    }
    const first = successes.find((entry) => entry.to !== undefined)
    clearWorktreeFileIndex(sessionId)
    if (destination !== '') await expandFolder(destination)
    await reloadExpanded()
    if (first?.to !== undefined) {
      // Let the refreshed rows render before selecting the new path; otherwise
      // the prune pass would drop a target the tree does not know yet.
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve())
      })
      selectOnly(first.to)
      setEditorMode('tab')
      if (mode === 'copy' && successes.length === 1) {
        const source = first.from ?? first.path
        if (kinds.get(source) === 'file') await openPath(first.to, 1)
      }
    }

    if (failures.length > 0) {
      const detail = failures[0]?.detail ?? t('files.notice.unknownError')
      notify({
        tone: 'error',
        message:
          mode === 'move'
            ? t('files.notice.movedSummary', {
                moved: successes.length,
                failed: failures.length,
                detail
              })
            : t('files.notice.copiedSummary', {
                copied: successes.length,
                failed: failures.length,
                detail
              }),
        ...(successes.length === 0
          ? {}
          : { action: { label: translate('files.undo'), run: () => void undoLast() } })
      })
    } else if (successes.length === 0) {
      notify({ tone: 'info', message: translate('files.notice.noMoveNeeded') })
    } else {
      notify({
        tone: 'success',
        message:
          mode === 'move'
            ? translatePlural('files.notice.moved', successes.length)
            : translatePlural('files.notice.copied', successes.length),
        action: { label: translate('files.undo'), run: () => void undoLast() }
      })
    }
    setTransferBusy(false)
    return { allOk: failures.length === 0, succeeded: successes.length, failures }
  }
  const pasteInto = async (destination: string): Promise<void> => {
    const current = filesClipboardStore.get()
    if (current === null || current.sessionId !== sessionId) {
      notify({
        tone: 'error',
        message:
          current === null
            ? translate('files.notice.clipboardEmpty')
            : translate('files.notice.sameWorktree')
      })
      return
    }
    const transferMode = current.mode === 'cut' ? 'move' : 'copy'
    const outcome = await performTransfer(transferMode, current.paths, destination)
    if (current.mode === 'cut') {
      if (outcome.allOk) filesClipboardStore.clear()
      else if (outcome.succeeded > 0) {
        filesClipboardStore.set({
          sessionId,
          paths: outcome.failures.map((entry) => entry.path),
          mode: 'cut'
        })
      }
    }
  }

  return {
    deletePrompt,
    setDeletePrompt,
    movePrompt,
    setMovePrompt,
    undoStack,
    setUndoStack,
    undoing,
    setUndoing,
    trashBanner,
    setTrashBanner,
    transferBusy,
    setTransferBusy,
    pushUndoEntry,
    closeTabsUnder,
    restoreTrashOp,
    requestDelete,
    confirmPermanentDelete,
    confirmTrashDelete,
    confirmDelete,
    undoLast,
    copySelection,
    duplicateSelection,
    copyPathsToClipboard,
    performTransfer,
    pasteInto,
    refreshTrash
  }
}
