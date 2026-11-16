/**
 * A renderer-wide signal that a panel drag is in progress.
 *
 * Layout code writes geometry straight to the DOM while a seam moves, so the
 * expensive consumers — terminal fits and element-width measurements — need to
 * know when to defer. The counter is ref-counted because two pointers (or a
 * split divider inside an inspector drag) can overlap.
 *
 * This module is deliberately DOM-free so the drag policy is testable in Node.
 */

export type ResizeActivityKind =
  | 'sidebar'
  | 'inspector'
  | 'scm-list'
  | 'files-list'
  | 'split'

type Listener = (active: boolean) => void

let activeCount = 0
const listeners = new Set<Listener>()

function notify(active: boolean): void {
  // A throwing subscriber must not break the pointerdown that started the drag.
  for (const listener of [...listeners]) {
    try {
      listener(active)
    } catch {
      // Subscribers own their failure; the drag continues.
    }
  }
}

/** Marks a drag as active. The returned end function is idempotent. */
export function beginResizeActivity(_kind: ResizeActivityKind): () => void {
  activeCount += 1
  if (activeCount === 1) notify(true)

  let ended = false
  return () => {
    if (ended) return
    ended = true
    activeCount = Math.max(0, activeCount - 1)
    if (activeCount === 0) notify(false)
  }
}

export function isResizeActive(): boolean {
  return activeCount > 0
}

export function subscribeResizeActivity(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
