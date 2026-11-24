import { useEffect, useMemo, useRef } from 'react'
import { fileTabs, useSessionFiles } from '../../files/open-files'
import {
  setSessionLiveState,
  useSessionTreeWatch
} from '../../files/session-watch-registry'
import { useFilesWatch } from '../../files/use-files-live'
import { deriveWatchRoots } from '../../files/watch-roots'

/**
 * The one files-watch owner for a worktree.
 *
 * Tabs and watch roots are workspace-scoped; the IPC subscription still needs
 * the worktree's owner session. The tree registry is shared with the inspector,
 * which registers under that owner today.
 */
export default function WorktreeFilesWatchHost({
  workspaceKey,
  ownerSessionId
}: {
  workspaceKey: string
  ownerSessionId: string | null
}): null {
  const sessionFiles = useSessionFiles(workspaceKey)
  const tree = useSessionTreeWatch(ownerSessionId ?? '')
  const files = fileTabs(sessionFiles)
  const tabPathsKey = files.map((tab) => tab.path).join('\u0000')
  const expanded = tree?.expanded ?? {}
  const expandedKey = Object.keys(expanded)
    .filter((path) => expanded[path] === true)
    .join('\u0000')

  const roots = useMemo(
    () =>
      deriveWatchRoots({
        expanded,
        tabPaths: files.map((tab) => tab.path)
      }),
    // Keys keep the array identity stable across unrelated store updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expandedKey, tabPathsKey]
  )

  const rootStateRef = useRef<'loading' | 'ready' | 'unavailable'>(tree?.rootState ?? 'ready')
  rootStateRef.current = tree?.rootState ?? 'ready'
  const reloadExpandedRef = useRef<() => Promise<void>>(async () => undefined)
  reloadExpandedRef.current = tree?.reloadExpanded ?? (async () => undefined)

  const active =
    ownerSessionId !== null && (tree?.visible === true || files.length > 0)
  const { liveState } = useFilesWatch({
    sessionId: ownerSessionId ?? '',
    scopeKey: workspaceKey,
    active,
    roots,
    rootStateRef,
    reloadExpandedRef
  })

  useEffect(() => {
    if (ownerSessionId === null) return
    setSessionLiveState(ownerSessionId, liveState)
  }, [liveState, ownerSessionId])

  return null
}
