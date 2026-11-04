import { describe, expect, it } from 'vitest'
import {
  GitOperationQueue,
  retryIndexLock
} from './operation-queue'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('GitOperationQueue', () => {
  it('serializes mutations for one key', async () => {
    const queue = new GitOperationQueue()
    let active = 0
    let maximum = 0
    const order: string[] = []
    const run = (name: string): Promise<void> =>
      queue.runExclusive('session', async () => {
        active += 1
        maximum = Math.max(maximum, active)
        order.push(name)
        await tick(5)
        active -= 1
      })
    await Promise.all([run('a'), run('b'), run('c')])
    expect(maximum).toBe(1)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('runs different keys concurrently', async () => {
    const queue = new GitOperationQueue()
    let active = 0
    let maximum = 0
    const run = (key: string): Promise<void> =>
      queue.runExclusive(key, async () => {
        active += 1
        maximum = Math.max(maximum, active)
        await tick(10)
        active -= 1
      })
    await Promise.all([run('one'), run('two')])
    expect(maximum).toBe(2)
  })

  it('keeps the queue usable after a rejected mutation', async () => {
    const queue = new GitOperationQueue()
    await expect(
      queue.runExclusive('session', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await expect(queue.runExclusive('session', async () => 'next')).resolves.toBe('next')
    await queue.idle('session')
  })

  it('cancels a mutation that is still waiting for its turn', async () => {
    const queue = new GitOperationQueue()
    let release: () => void = () => undefined
    const blocker = queue.runExclusive(
      'session',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const controller = new AbortController()
    const waiting = queue.runExclusive('session', async () => 'ran', { signal: controller.signal })
    await tick(1)
    controller.abort()
    release()
    await blocker
    await expect(waiting).rejects.toHaveProperty('name', 'AbortError')
    await expect(queue.runExclusive('session', async () => 'still works')).resolves.toBe('still works')
  })

  it('tracks and cancels overlapping reads without blocking mutations', async () => {
    const queue = new GitOperationQueue()
    const signals: AbortSignal[] = []
    const reads = [0, 1, 2].map((index) =>
      queue.read('session', async (signal) => {
        signals.push(signal)
        await tick(20)
        return index
      })
    )
    await tick(1)
    expect(queue.activeReads('session')).toBe(3)
    expect(queue.cancelReads('session')).toBe(3)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    await Promise.all(reads)
    expect(queue.activeReads('session')).toBe(0)
  })

  it('forwards an outer abort to the read signal', async () => {
    const queue = new GitOperationQueue()
    const outer = new AbortController()
    const captured: { signal?: AbortSignal } = {}
    const read = queue.read(
      'session',
      async (signal) => {
        captured.signal = signal
        await tick(10)
      },
      { signal: outer.signal }
    )
    await tick(1)
    outer.abort()
    expect(captured.signal?.aborted).toBe(true)
    await read
  })
})

describe('retryIndexLock', () => {
  it('retries lock contention and then succeeds', async () => {
    const delays: number[] = []
    let attempts = 0
    const value = await retryIndexLock(
      async () => {
        attempts += 1
        if (attempts < 3) throw new Error('fatal: Unable to create index.lock: File exists')
        return 'ok'
      },
      {
        baseDelayMs: 10,
        random: () => 0.5,
        sleep: async (ms) => {
          delays.push(ms)
        }
      }
    )
    expect(value).toBe('ok')
    expect(attempts).toBe(3)
    expect(delays).toEqual([8, 15])
  })

  it('does not retry a non-lock failure', async () => {
    let attempts = 0
    await expect(
      retryIndexLock(
        async () => {
          attempts += 1
          throw new Error('CONFLICT (content): Merge conflict in src/a.ts')
        },
        { sleep: async () => undefined }
      )
    ).rejects.toThrow('CONFLICT')
    expect(attempts).toBe(1)
  })

  it('stops at the attempt ceiling and rethrows the lock error', async () => {
    let attempts = 0
    await expect(
      retryIndexLock(
        async () => {
          attempts += 1
          throw new Error('Another git process seems to be running in this repository')
        },
        { attempts: 3, sleep: async () => undefined }
      )
    ).rejects.toThrow('Another git process')
    expect(attempts).toBe(3)
  })

  it('stops retrying when aborted', async () => {
    const controller = new AbortController()
    let attempts = 0
    const run = retryIndexLock(
      async () => {
        attempts += 1
        throw new Error('Unable to create index.lock')
      },
      {
        attempts: 5,
        signal: controller.signal,
        sleep: async () => {
          controller.abort()
        }
      }
    )
    await expect(run).rejects.toHaveProperty('name', 'AbortError')
    expect(attempts).toBe(1)
  })
})
