import { describe, expect, it } from 'vitest'
import type { TerminalInstanceLike } from './terminal-instance'
import { TerminalRegistry, type TerminalFactory } from './terminal-registry'
import type { TerminalStatus } from './session-terminal'

const STATUS: TerminalStatus = {
  phase: 'connecting',
  message: null,
  incarnationId: null,
  exitCode: null,
  error: null
}

class FakeInstance implements TerminalInstanceLike {
  attached = false
  disposed = false

  constructor(readonly key: string) {}

  attachToElement(_container: HTMLElement): number {
    this.attached = true
    return 1
  }
  detach(_attachment?: number | null): void {
    this.attached = false
  }
  setActive(): void {}
  fit(): void {}
  focus(): void {}
  retry(): void {}
  dispose(): void {
    this.disposed = true
    this.attached = false
  }
  isAttached(): boolean {
    return this.attached
  }
  isDisposed(): boolean {
    return this.disposed
  }
  subscribe(): () => void {
    return () => undefined
  }
  getStatus(): TerminalStatus {
    return STATUS
  }
}

function setup(): {
  registry: TerminalRegistry
  created: FakeInstance[]
  acquire: (sessionId: string, incarnationId?: string | null) => TerminalInstanceLike
} {
  const created: FakeInstance[] = []
  const factory: TerminalFactory = (options) => {
    const instance = new FakeInstance(options.key)
    created.push(instance)
    return instance
  }
  const registry = new TerminalRegistry(factory)
  return {
    registry,
    created,
    acquire: (sessionId, incarnationId = 'inc_1') =>
      registry.acquire({
        sessionId,
        incarnationId,
        onError: () => undefined
      })
  }
}

describe('terminal registry', () => {
  it('reuses one instance for the same session and incarnation', () => {
    const { registry, created, acquire } = setup()
    const first = acquire('ses_one')
    const second = acquire('ses_one')
    expect(second).toBe(first)
    expect(created).toHaveLength(1)
    expect(registry.size()).toBe(1)
  })

  it('offers a side-effect-free peek for a remounting view', () => {
    const { registry, acquire } = setup()
    expect(registry.peek('ses_one', 'inc_1')).toBeNull()
    const instance = acquire('ses_one')
    expect(registry.peek('ses_one', 'inc_1')).toBe(instance)
    registry.release(instance)
    registry.retain(new Set())
    expect(registry.peek('ses_one', 'inc_1')).toBeNull()
  })

  it('keys a new instance for a new incarnation', () => {
    const { registry, created, acquire } = setup()
    const first = acquire('ses_one', 'inc_1')
    const second = acquire('ses_one', 'inc_2')
    expect(second).not.toBe(first)
    expect(created).toHaveLength(2)
    expect(registry.size()).toBe(2)
  })

  it('keeps a released instance while its session is retained', () => {
    const { registry, created, acquire } = setup()
    const instance = acquire('ses_one')
    registry.retain(new Set([instance.key]))
    instance.attachToElement({} as HTMLElement)
    registry.release(instance, 1)
    expect(instance.isAttached()).toBe(false)
    expect(instance.isDisposed()).toBe(false)
    expect(registry.size()).toBe(1)
    expect(created).toHaveLength(1)
  })

  it('disposes a released instance that is no longer retained', () => {
    const { registry, created, acquire } = setup()
    const instance = acquire('ses_one')
    registry.retain(new Set([instance.key]))
    registry.release(instance)
    expect(instance.isDisposed()).toBe(false)

    registry.retain(new Set())
    expect(instance.isDisposed()).toBe(true)
    expect(registry.size()).toBe(0)
    expect(created).toHaveLength(1)
  })

  it('never disposes an instance while a view is attached', () => {
    const { registry, acquire } = setup()
    const instance = acquire('ses_one')
    instance.attachToElement({} as HTMLElement)
    registry.retain(new Set())
    expect(instance.isDisposed()).toBe(false)
    registry.release(instance, 1)
    expect(instance.isDisposed()).toBe(true)
  })

  it('creates a fresh instance after disposal', () => {
    const { registry, created, acquire } = setup()
    const first = acquire('ses_one')
    registry.release(first)
    registry.retain(new Set())
    expect(first.isDisposed()).toBe(true)

    const second = acquire('ses_one')
    expect(second).not.toBe(first)
    expect(created).toHaveLength(2)
  })

  it('disposes everything on window teardown', () => {
    const { registry, acquire } = setup()
    const first = acquire('ses_one')
    const second = acquire('ses_two')
    registry.disposeAll()
    expect(first.isDisposed()).toBe(true)
    expect(second.isDisposed()).toBe(true)
    expect(registry.size()).toBe(0)
  })
})
