import { useCallback, useRef, useState } from 'react'
import { callApi, errorNotice } from '../lib/api'
import type {
  FilesListingPayload,
  GitCheckIgnorePayload
} from '../../../shared/icode-api'
import type { FileEntry } from '../../../shared/domain/workspace-files'
import { parentPathOf } from './file-paths'
import { isGitMetadata, unavailableText } from './search-utils'
import {
  EMPTY_SELECTION,
  collapseSelectedPaths,
  type SelectionState
} from './selection'
import { translate } from '../i18n/i18n-store'
import type { Notice } from '../state/workspace'
import type { FilesSettings } from './files-settings'

export type TreeState = {
  expanded: Record<string, boolean>
  children: Record<string, FileEntry[]>
  loading: Record<string, boolean>
}

export function useFilesTree(input: {
  sessionId: string
  refreshToken: number
  settings: FilesSettings
  notify: (notice: Notice) => void
}) {
  const { sessionId, refreshToken, settings, notify } = input
  const [tree, setTree] = useState<TreeState>({
    expanded: { '': true },
    children: {},
    loading: {}
  })
  const [rootState, setRootState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [rootNote, setRootNote] = useState('')
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  const [collapsedNested, setCollapsedNested] = useState<Set<string>>(new Set())
  const [ignoredByDirectory, setIgnoredByDirectory] = useState<
    Record<string, ReadonlySet<string>>
  >({})
  const [ignoreNote, setIgnoreNote] = useState('')

  /** Directories listed only so a compact chain can be labelled and refreshed. */
  const preloadedDirectories = useRef<Set<string>>(new Set())
  const compactFoldersRef = useRef(settings.compactFolders)
  compactFoldersRef.current = settings.compactFolders
  const excludeGitIgnoreRef = useRef(settings.excludeGitIgnore)
  excludeGitIgnoreRef.current = settings.excludeGitIgnore
  const revealPathRef = useRef<((path: string) => Promise<void>) | null>(null)
  const rootStateRef = useRef(rootState)
  rootStateRef.current = rootState

  /** Invalidates in-flight directory reads when the session or refresh key changes. */
  const treeGeneration = useRef(0)
  const treeResetKey = useRef('')
  const resetKey = `${sessionId}\u0000${String(refreshToken)}`
  if (treeResetKey.current !== resetKey) {
    treeResetKey.current = resetKey
    treeGeneration.current += 1
  }

  const loadDirectory = useCallback(
    async (
      path: string,
      quiet = false,
      chainDepth = 0,
      /** Only a user-visible expansion discovers chains in sibling folders. */
      allowFanout = true
    ): Promise<void> => {
      const generation = treeGeneration.current
      setTree((current) => ({ ...current, loading: { ...current.loading, [path]: true } }))
      const result = await callApi<FilesListingPayload>(
        window.icode.files.list({ sessionId, path })
      )
      if (generation !== treeGeneration.current) return
      if (!result.ok) {
        if (!quiet) notify(errorNotice(result.error))
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
        setRootNote(value.truncated ? translate('files.truncatedRoot') : '')
      }
      if (excludeGitIgnoreRef.current && value.entries.length > 0) {
        const check = await callApi<GitCheckIgnorePayload>(
          window.icode.git.checkIgnore({
            sessionId,
            paths: value.entries.map((entry) => entry.path)
          })
        )
        if (generation !== treeGeneration.current) return
        if (check.ok && check.value.status === 'ok') {
          const ignored = new Set(check.value.ignored)
          setIgnoredByDirectory((current) => ({ ...current, [path]: ignored }))
          setIgnoreNote('')
        } else {
          setIgnoredByDirectory((current) => {
            const next = { ...current }
            delete next[path]
            return next
          })
          setIgnoreNote(translate('files.ignoreUnavailable'))
        }
      } else if (excludeGitIgnoreRef.current) {
        setIgnoredByDirectory((current) => ({ ...current, [path]: new Set() }))
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
      // Compact labels need the next level of single-directory chains. A user
      // expansion speculatively lists its directory children (bounded) so the
      // first render already shows `a/b/c`; the recursive preloads only follow
      // chains, so this never walks a whole subtree.
      if (generation !== treeGeneration.current) return
      const candidates: FileEntry[] = []
      if (compactFoldersRef.current && chainDepth < 64) {
        const only = value.entries[0]
        if (
          value.entries.length === 1 &&
          only !== undefined &&
          only.kind === 'directory' &&
          !isGitMetadata(only.path)
        ) {
          candidates.push(only)
        } else if (allowFanout) {
          for (const entry of value.entries) {
            if (entry.kind === 'directory' && !isGitMetadata(entry.path)) {
              candidates.push(entry)
            }
          }
        }
      }
      const preloadLimit = allowFanout ? 24 : 1
      for (const child of candidates.slice(0, preloadLimit)) {
        preloadedDirectories.current.add(child.path)
        void loadDirectory(child.path, true, chainDepth + 1, false)
      }
    },
    [notify, sessionId]
  )

  const revealPath = useCallback(
    async (path: string): Promise<void> => {
      const segments = path.split('/')
      if (segments.length <= 1) return
      const loaded = new Set(Object.keys(tree.children))
      let prefix = ''
      for (let index = 0; index < segments.length - 1; index += 1) {
        prefix = prefix === '' ? (segments[index] ?? '') : `${prefix}/${segments[index] ?? ''}`
        setTree((current) =>
          current.expanded[prefix] === true
            ? current
            : { ...current, expanded: { ...current.expanded, [prefix]: true } }
        )
        if (!loaded.has(prefix)) {
          loaded.add(prefix)
          await loadDirectory(prefix)
        }
      }
    },
    [loadDirectory, tree.children]
  )
  revealPathRef.current = revealPath

  const findEntry = (path: string): FileEntry | null => {
    for (const entries of Object.values(tree.children)) {
      const found = entries.find((entry) => entry.path === path)
      if (found) return found
    }
    return null
  }

  const siblingsOf = (parent: string): string[] =>
    (tree.children[parent] ?? []).map((entry) => entry.name)

  const selectedPaths = (): string[] => {
    const paths = collapseSelectedPaths([...selection.selected])
    if (paths.length > 0) return paths
    return selection.focused === null ? [] : [selection.focused]
  }

  const createParent = (): string => {
    const focused =
      selection.focused !== null && selection.selected.has(selection.focused)
        ? findEntry(selection.focused)
        : null
    if (focused?.kind === 'directory') return focused.path
    if (focused !== null) return parentPathOf(focused.path)
    if (selection.selected.size === 1) {
      const only = findEntry([...selection.selected][0] ?? '')
      if (only?.kind === 'directory') return only.path
      if (only !== null) return parentPathOf(only.path)
    }
    return ''
  }

  const selectOnly = (path: string): void => {
    setSelection({ selected: new Set([path]), anchor: path, focused: path })
  }

  const expandFolder = async (path: string): Promise<void> => {
    setTree((current) => ({ ...current, expanded: { ...current.expanded, [path]: true } }))
    // Always refresh on expansion: the row may have been preloaded only as a
    // side effect of compact-chain discovery in its parent.
    await loadDirectory(path)
  }

  return {
    tree,
    setTree,
    rootState,
    setRootState,
    rootNote,
    setRootNote,
    selection,
    setSelection,
    collapsedNested,
    setCollapsedNested,
    ignoredByDirectory,
    setIgnoredByDirectory,
    ignoreNote,
    setIgnoreNote,
    preloadedDirectories,
    treeGeneration,
    rootStateRef,
    revealPathRef,
    loadDirectory,
    revealPath,
    findEntry,
    siblingsOf,
    selectedPaths,
    createParent,
    selectOnly,
    expandFolder
  }
}
