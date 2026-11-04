/**
 * Serializes iCode's own Git mutations per worktree.
 *
 * The live Agent is a concurrent Git user, so a queue cannot make the
 * repository exclusive. It can guarantee that two iCode batch operations do not
 * race each other on the index; the Agent's processes are handled separately by
 * bounded `index.lock` retries. Reads are never serialized: a status or diff
 * answer may overlap a mutation, and callers cancel a superseded read instead of
 * waiting for it.
 */

import { isIndexLockFailure } from './git-errors'

export function abortError(message = 'The operation was cancelled.'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export type GitOperationQueueOptions = {
  now?: () => number
}

export class GitOperationQueue {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly reads = new Map<string, Set<AbortController>>()
  private readonly now: () => number

  constructor(options: GitOperationQueueOptions = {}) {
    this.now = options.now ?? Date.now
  }

  /**
   * Runs one mutation after every earlier mutation for the same key. A rejected
   * mutation does not poison the queue; the next caller still runs.
   */
  async runExclusive<T>(
    key: string,
    task: () => Promise<T>,
    options: { signal?: AbortSignal } = {}
  ): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const run = previous.then(async () => {
      if (options.signal?.aborted) throw abortError()
      return task()
    })
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(key, tail)
    try {
      return await run
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  /**
   * Runs a cancellable read. Reads overlap each other and mutations; the
   * returned signal must be passed to the Git executor so cancellation reaches
   * the child process rather than only the promise.
   */
  async read<T>(
    key: string,
    task: (signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal } = {}
  ): Promise<T> {
    const controller = new AbortController()
    const set = this.reads.get(key) ?? new Set<AbortController>()
    set.add(controller)
    this.reads.set(key, set)
    const forwardAbort = (): void => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', forwardAbort, { once: true })
    try {
      if (controller.signal.aborted) throw abortError()
      return await task(controller.signal)
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort)
      set.delete(controller)
      if (set.size === 0 && this.reads.get(key) === set) this.reads.delete(key)
    }
  }

  /** Cancels reads for one worktree; queued mutations are untouched. */
  cancelReads(key: string): number {
    const set = this.reads.get(key)
    if (!set) return 0
    const count = set.size
    for (const controller of set) controller.abort()
    this.reads.delete(key)
    return count
  }

  cancelAllReads(): number {
    let count = 0
    for (const key of [...this.reads.keys()]) count += this.cancelReads(key)
    return count
  }

  /** Test/diagnostic seam: the number of tracked reads. */
  activeReads(key?: string): number {
    if (key !== undefined) return this.reads.get(key)?.size ?? 0
    let total = 0
    for (const set of this.reads.values()) total += set.size
    return total
  }

  /** Resolves when the mutation chain for a key is empty. */
  async idle(key: string): Promise<void> {
    await (this.tails.get(key) ?? Promise.resolve())
  }

  /**
   * Exposed for diagnostics; the clock is injectable so tests do not sleep.
   */
  nowMs(): number {
    return this.now()
  }
}

export type IndexLockRetryOptions = {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
  /** Injected by tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
  /** Injected by tests; defaults to `Math.random`. */
  random?: () => number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { stderr?: unknown }).stderr
    if (typeof cause === 'string') return `${error.message}\n${cause}`
    return error.message
  }
  return typeof error === 'string' ? error : ''
}

/**
 * Retries only an `index.lock` failure, with bounded exponential backoff.
 *
 * A timeout or a real Git failure is never retried: after a mutation the
 * outcome is unknown, and re-running `git add` or `git commit` could apply it
 * twice. The caller must therefore invoke this around operations that are safe
 * to repeat or whose failure was specifically lock contention.
 */
export async function retryIndexLock<T>(
  task: () => Promise<T>,
  options: IndexLockRetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 4))
  const base = Math.max(0, options.baseDelayMs ?? 50)
  const max = Math.max(base, options.maxDelayMs ?? 500)
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError()
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (!isIndexLockFailure(messageOf(error))) throw error
      if (attempt === attempts - 1) throw error
      const ceiling = Math.min(max, base * 2 ** attempt)
      const jittered = ceiling * (0.5 + random() * 0.5)
      await sleep(Math.round(jittered))
    }
  }
  throw lastError
}
