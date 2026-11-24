import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { callApi } from '../lib/api'
import type {
  FileContentPayload,
  FilesStatPayload,
  GitStatusPayload
} from '../../../shared/icode-api'
import { clearWorktreeFileIndex } from './file-index'
import {
  EMPTY_DECORATIONS,
  buildFileDecorations,
  type FileDecorations
} from './file-decorations'
import { fileTabs, isDirty, openFilesStore } from './open-files'

export type LiveState = 'off' | 'watch' | 'poll'

/** Git decorations for the tree; one status read per debounced watcher tick. */
export function useFilesDecorations(input: {
  sessionId: string
  active: boolean
  gitDecorations: boolean
}) {
  const { sessionId, active, gitDecorations } = input
  const [decorations, setDecorations] = useState<FileDecorations>(EMPTY_DECORATIONS)
  const decorationTimer = useRef<number | null>(null)
  const decorationBusy = useRef(false)
  const decorationAgain = useRef(false)
  const decorationsEnabled = useRef(gitDecorations)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const activeRef = useRef(active)
  activeRef.current = active
  const scheduleDecorationsRef = useRef<((delay?: number) => void) | null>(null)

  /**
   * Git decorations are a lightweight status read while Files is visible. The
   * Files watcher schedules a debounced refresh; there is no second watcher.
   */
  const fetchDecorations = useCallback(async (): Promise<void> => {
    if (!decorationsEnabled.current || !activeRef.current) return
    if (decorationBusy.current) {
      decorationAgain.current = true
      return
    }
    decorationBusy.current = true
    const requestSession = sessionId
    const result = await callApi<GitStatusPayload>(
      window.icode.git.status({ sessionId })
    )
    decorationBusy.current = false
    if (
      requestSession !== sessionIdRef.current ||
      !decorationsEnabled.current ||
      !activeRef.current
    ) {
      return
    }
    if (result.ok && result.value.status === 'ok') {
      setDecorations(buildFileDecorations(result.value.snapshot))
    } else {
      setDecorations(EMPTY_DECORATIONS)
    }
    if (decorationAgain.current) {
      decorationAgain.current = false
      scheduleDecorationsRef.current?.()
    }
  }, [sessionId])

  const scheduleDecorations = useCallback(
    (delay = 400): void => {
      if (!decorationsEnabled.current || !activeRef.current) return
      if (decorationTimer.current !== null) window.clearTimeout(decorationTimer.current)
      decorationTimer.current = window.setTimeout(() => {
        decorationTimer.current = null
        void fetchDecorations()
      }, delay)
    },
    [fetchDecorations]
  )
  scheduleDecorationsRef.current = scheduleDecorations

  useEffect(() => {
    decorationsEnabled.current = gitDecorations
    if (!active || !gitDecorations) {
      setDecorations(EMPTY_DECORATIONS)
      return
    }
    void fetchDecorations()
    return () => {
      if (decorationTimer.current !== null) {
        window.clearTimeout(decorationTimer.current)
        decorationTimer.current = null
      }
    }
  }, [active, fetchDecorations, gitDecorations])

  return { decorations, setDecorations, scheduleDecorationsRef }
}

/** Watches the worktree while Files is visible, with a poll fallback. */
export function useFilesWatch(input: {
  sessionId: string
  active: boolean
  roots: readonly string[]
  rootStateRef: MutableRefObject<'loading' | 'ready' | 'unavailable'>
  reloadExpandedRef: MutableRefObject<
    (quiet?: boolean, discover?: boolean) => Promise<void>
  >
}) {
  const { sessionId, active, roots, rootStateRef, reloadExpandedRef } = input
  const [liveState, setLiveState] = useState<LiveState>('off')
  const rootsKey = roots.join('\u0000')
  const sentRootsKey = useRef<string | null>(null)

  useEffect(() => {
    if (!active) {
      setLiveState('off')
      return
    }
    let cancelled = false
    let pollTimer: number | null = null
    const retryTimers: number[] = []
    let retriesScheduled = false

    const reloadCleanTab = async (path: string): Promise<void> => {
      const read = await callApi<FileContentPayload>(
        window.icode.files.read({ sessionId, path })
      )
      if (cancelled || openFilesStore.find(sessionId, path) === null) return
      if (!read.ok) return
      const value = read.value
      if (value.status === 'unavailable') {
        if (value.reason === 'not-found') openFilesStore.markDiskDeleted(sessionId, path)
        return
      }
      if (value.binary || value.tooLarge) {
        openFilesStore.markDiskChanged(sessionId, path)
        return
      }
      // The user may have typed while the read was in flight. Never replace a
      // buffer that became dirty after the clean check.
      const current = openFilesStore.find(sessionId, path)
      if (current === null) return
      if (isDirty(current)) {
        openFilesStore.markDiskChanged(sessionId, path)
        return
      }
      openFilesStore.setContent(sessionId, path, { text: value.text, etag: value.etag })
    }

    let reconciling = false
    let reconcileAgain = false

    const reconcile = async (): Promise<void> => {
      if (cancelled || rootStateRef.current !== 'ready') return
      if (reconciling) {
        reconcileAgain = true
        return
      }
      reconciling = true
      try {
        await reloadExpandedRef.current(true)
        clearWorktreeFileIndex(sessionId)
        const state = openFilesStore.get(sessionId)
        for (const tab of fileTabs(state)) {
          if (cancelled) return
          if (tab.load !== 'ready') continue
          const stat = await callApi<FilesStatPayload>(
            window.icode.files.stat({ sessionId, path: tab.path })
          )
          if (cancelled) return
          if (!stat.ok) continue
          const value = stat.value
          if (value.status === 'unavailable') {
            if (value.reason === 'not-found') {
              openFilesStore.markDiskDeleted(sessionId, tab.path)
            }
            continue
          }
          if (value.etag === tab.etag) {
            openFilesStore.markDiskCurrent(sessionId, tab.path)
            continue
          }
          const current = openFilesStore.find(sessionId, tab.path)
          if (current === null) continue
          if (isDirty(current)) openFilesStore.markDiskChanged(sessionId, current.path)
          else await reloadCleanTab(current.path)
        }
      } finally {
        reconciling = false
        if (reconcileAgain && !cancelled) {
          reconcileAgain = false
          void reconcile()
        }
      }
    }

    const startPolling = (): void => {
      if (cancelled || pollTimer !== null) return
      setLiveState('poll')
      pollTimer = window.setInterval(() => {
        void reconcile()
      }, 2000)
    }

    /**
     * A watcher child crash is temporary: keep polling, but give the watch a
     * few bounded chances to come back without waiting for a visibility change.
     */
    const clearRetries = (): void => {
      while (retryTimers.length > 0) window.clearTimeout(retryTimers.pop())
      retriesScheduled = false
    }
    const scheduleWatchRetries = (): void => {
      if (cancelled || retriesScheduled) return
      retriesScheduled = true
      for (const delay of [5_000, 20_000, 60_000]) {
        retryTimers.push(
          window.setTimeout(() => {
            if (cancelled) return
            void window.icode.files.watch({ sessionId, active: true }).then((result) => {
              if (cancelled) return
              if (!result.ok || !result.value.watching) return
              clearRetries()
              setLiveState('watch')
              if (pollTimer !== null) {
                window.clearInterval(pollTimer)
                pollTimer = null
              }
              void reconcile()
            })
          }, delay)
        )
      }
    }

    const unsubscribe = window.icode.files.onChanged((event) => {
      if (event.sessionId !== sessionId) return
      if (event.failed) {
        startPolling()
        scheduleWatchRetries()
        return
      }
      setLiveState('watch')
      void reconcile()
    })

    void reconcile()
    sentRootsKey.current = rootsKey
    void window.icode.files
      .watch({ sessionId, active: true, roots: [...roots] })
      .then((result) => {
        if (cancelled) return
        if (!result.ok || !result.value.watching) {
          startPolling()
          scheduleWatchRetries()
          return
        }
        setLiveState('watch')
        void reconcile()
      })

    return () => {
      cancelled = true
      unsubscribe()
      clearRetries()
      sentRootsKey.current = null
      if (pollTimer !== null) window.clearInterval(pollTimer)
      setLiveState('off')
      void window.icode.files.watch({ sessionId, active: false })
    }
  }, [active, sessionId])

  /*
   * Expanding or collapsing a folder changes the watch roots without tearing
   * down the watcher. The root set is debounced so a burst of expansions is
   * one update; the `ready`/overflow path reconciles once it is bound.
   */
  useEffect(() => {
    if (!active || sentRootsKey.current === rootsKey) return
    const timer = window.setTimeout(() => {
      sentRootsKey.current = rootsKey
      void window.icode.files.watch({ sessionId, active: true, roots: [...roots] })
    }, 150)
    return () => window.clearTimeout(timer)
  }, [active, rootsKey, sessionId])

  return { liveState }
}
