import { describe, expect, it } from 'vitest'
import { GitOperationQueue } from './operation-queue'

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


})
