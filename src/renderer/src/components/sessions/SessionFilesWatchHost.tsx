import { useEffect, useMemo, useRef } from 'react'
import { fileTabs, useSessionFiles } from '../../files/open-files'
import {
  setSessionLiveState,
  useSessionTreeWatch
} from '../../files/session-watch-registry'
import { useFilesWatch } from '../../files/use-files-live'
import { deriveWatchRoots } from '../../files/watch-roots'

/**
 * The one files-watch owner for a session in the sessions surface.
 *
 * The inspector's tree contributes expanded folders and visibility through the
 * registry; open file tabs contribute their parent folders. Main keeps a single
 * subscription per session, so this host must be unique — the tree never calls
 * `useFilesWatch` in list-only mode.
 */
export default function SessionFilesWatchHost({
  sessionId
}: {
  sessionId: string
}): null {
  const sessionFiles = useSessionFiles(sessionId)
  const tree = useSessionTreeWatch(sessionId)
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

  const active = tree?.visible === true || files.length > 0
  const { liveState } = useFilesWatch({
    sessionId,
    active,
    roots,
    rootStateRef,
    reloadExpandedRef
  })

  useEffect(() => {
    setSessionLiveState(sessionId, liveState)
  }, [liveState, sessionId])

  return null
}
