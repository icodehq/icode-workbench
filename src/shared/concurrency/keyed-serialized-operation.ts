/**
 * One queue per key, for mutations that must not interleave (a group room, a bot's
 * chat). Adapted under the MIT license; see NOTICE.
 *
 * Queue tails never reject; an operation's failure reaches only its own caller.
 */
export function runKeyedSerializedOperation<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const current = previous.then(operation)
  const queued = current.then(
    () => undefined,
    () => undefined
  )
  queues.set(key, queued)

  const clear = (): void => {
    if (queues.get(key) === queued) queues.delete(key)
  }
  queued.then(clear, clear)
  return current
}

export function getKeyedSerializedQueueTail(
  queues: Map<string, Promise<void>>,
  key: string
): Promise<void> {
  return queues.get(key) ?? Promise.resolve()
}
