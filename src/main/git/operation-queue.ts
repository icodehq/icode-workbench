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

export function abortError(message = 'The operation was cancelled.'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export class GitOperationQueue {
  private readonly tails = new Map<string, Promise<void>>()
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


}
