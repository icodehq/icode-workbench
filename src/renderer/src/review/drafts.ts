import { useCallback, useSyncExternalStore } from 'react'
import type { AgentSendResult } from '../lib/agent-send'

/**
 * Review drafts belong to a work item, not to the panel that happens to be
 * mounted.
 *
 * The Changes tab unmounts while the user visits Terminal or Files, and a task
 * can be closed and reopened later in the same window. Line notes and the commit
 * message must survive both moves; the design contract also requires a failed
 * send to keep the draft. A tiny external store is enough: it is deliberately in
 * memory, so an app restart starts clean and no partial review text is invented
 * from persistence.
 */

export type LineComment = {
  id: string
  path: string
  side: 'new' | 'old'
  line: number
  text: string
}

export type WorkbenchDraft = {
  comments: LineComment[]
  commitMessage: string
}

export const EMPTY_DRAFT: WorkbenchDraft = Object.freeze({
  comments: Object.freeze([]) as unknown as LineComment[],
  commitMessage: ''
})

type Updater = Partial<WorkbenchDraft> | ((current: WorkbenchDraft) => WorkbenchDraft)

export class WorkbenchDraftStore {
  private readonly drafts = new Map<string, WorkbenchDraft>()
  private readonly listeners = new Set<() => void>()

  get(sessionId: string): WorkbenchDraft {
    return this.drafts.get(sessionId) ?? EMPTY_DRAFT
  }

  update(sessionId: string, updater: Updater): void {
    const current = this.get(sessionId)
    const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater }
    if (
      next.comments === current.comments && next.commitMessage === current.commitMessage
    ) {
      return
    }
    this.drafts.set(sessionId, next)
    for (const listener of this.listeners) listener()
  }

  /** Keeps only drafts for sessions this window still knows about. */
  retain(sessionIds: ReadonlySet<string>): void {
    let changed = false
    for (const sessionId of this.drafts.keys()) {
      if (sessionIds.has(sessionId)) continue
      this.drafts.delete(sessionId)
      changed = true
    }
    if (changed) for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/**
 * Applies one completed send to a draft.
 *
 * A failed send is a no-op: the panel's error message may explain the refusal,
 * but the user's text stays. A successful send removes only what was actually
 * sent, so a note added while the terminal was busy is not lost.
 */
export function afterAgentSend(
  current: WorkbenchDraft,
  sent: { commentIds?: ReadonlySet<string> },
  result: AgentSendResult
): WorkbenchDraft {
  if (!result.ok) return current
  const comments =
    sent.commentIds === undefined
      ? current.comments
      : current.comments.filter((comment) => !sent.commentIds?.has(comment.id))
  return { ...current, comments }
}

/** Keeps one Changes panel subscribed to its session's draft only. */
export function useWorkbenchDraft(
  store: WorkbenchDraftStore,
  sessionId: string
): WorkbenchDraft {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => store.subscribe(listener),
    [store]
  )
  const getSnapshot = useCallback((): WorkbenchDraft => store.get(sessionId), [sessionId, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
