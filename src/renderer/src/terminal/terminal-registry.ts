import type { AppError } from '../../../shared/domain/errors'
import { paneKey } from '../state/session-panes'
import type { TerminalInstanceLike } from './terminal-instance'

/**
 * Renderer terminal instances, keyed by session and incarnation.
 *
 * The registry is the owner of a terminal's lifetime, not the React view that
 * displays it. A view acquires an instance, moves its wrapper into a container,
 * and releases it on unmount; disposal only happens when the session is no
 * longer retained (removed, or replaced by a new incarnation) and no view is
 * attached.
 */

export type TerminalFactory = (options: {
  key: string
  sessionId: string
  onError: (error: AppError) => void
}) => TerminalInstanceLike

export type TerminalAcquireInput = {
  sessionId: string
  incarnationId: string | null
  onError: (error: AppError) => void
}

export class TerminalRegistry {
  private readonly instances = new Map<string, TerminalInstanceLike>()
  private retained: ReadonlySet<string> = new Set()

  constructor(private readonly create: TerminalFactory) {}

  /**
   * A synchronous, side-effect-free lookup for a view's first render.
   *
   * A pane that remounts after a split/swap finds its existing instance here,
   * so it paints the live status immediately instead of flashing `connecting`
   * for the frame before the acquisition effect runs.
   */
  peek(sessionId: string, incarnationId: string | null): TerminalInstanceLike | null {
    const instance = this.instances.get(paneKey(sessionId, incarnationId))
    return instance !== undefined && !instance.isDisposed() ? instance : null
  }

  acquire(input: TerminalAcquireInput): TerminalInstanceLike {
    const key = paneKey(input.sessionId, input.incarnationId)
    const existing = this.instances.get(key)
    if (existing !== undefined && !existing.isDisposed()) return existing
    const instance = this.create({
      key,
      sessionId: input.sessionId,
      onError: input.onError
    })
    this.instances.set(key, instance)
    return instance
  }

  /** Detaches the view's attachment and disposes only when nothing retains it. */
  release(instance: TerminalInstanceLike, attachment: number | null = null): void {
    if (attachment !== null) instance.detach(attachment)
    if (!this.retained.has(instance.key) && !instance.isAttached()) {
      this.dispose(instance.key)
    }
  }

  /**
   * The set of instances that may stay alive without a view. Mirrors the pane
   * retention rule: live/starting sessions plus the last frame of an exited one.
   */
  retain(keys: ReadonlySet<string>): void {
    this.retained = keys
    for (const key of [...this.instances.keys()]) {
      const instance = this.instances.get(key)
      if (instance === undefined) continue
      if (!keys.has(key) && !instance.isAttached()) this.dispose(key)
    }
  }

  disposeAll(): void {
    for (const key of [...this.instances.keys()]) this.dispose(key)
  }

  /** Test/diagnostic access to the live instance count. */
  size(): number {
    return this.instances.size
  }

  private dispose(key: string): void {
    const instance = this.instances.get(key)
    if (instance === undefined) return
    this.instances.delete(key)
    instance.dispose()
  }
}
