import type { Disposable, PtyExitEvent, PtyLike, PtySpawnConfig } from './pty-registry'

type Listener<T> = (value: T) => void

export class FakePty implements PtyLike {
  static nextPid = 5000
  static instances: FakePty[] = []

  readonly pid: number
  readonly config: PtySpawnConfig
  readonly writes: string[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  pauseCount = 0
  resumeCount = 0
  killed = false
  private dataListeners = new Set<Listener<string>>()
  private exitListeners = new Set<Listener<PtyExitEvent>>()
  private disposed = false

  constructor(config: PtySpawnConfig) {
    this.config = config
    this.pid = FakePty.nextPid++
    FakePty.instances.push(this)
  }

  static reset(): void {
    FakePty.nextPid = 5000
    FakePty.instances = []
  }

  static last(): FakePty {
    const instance = FakePty.instances.at(-1)
    if (!instance) throw new Error('No fake PTY was created')
    return instance
  }

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }

  kill(): void {
    this.killed = true
    this.emitExit({ exitCode: 0, signal: 15 })
  }

  pause(): void {
    this.pauseCount += 1
  }

  resume(): void {
    this.resumeCount += 1
  }

  onData(listener: Listener<string>): Disposable {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onExit(listener: Listener<PtyExitEvent>): Disposable {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  emitData(data: string): void {
    if (this.disposed) return
    for (const listener of this.dataListeners) listener(data)
  }

  emitExit(event: PtyExitEvent): void {
    if (this.disposed) return
    this.disposed = true
    for (const listener of this.exitListeners) listener(event)
    this.dataListeners.clear()
    this.exitListeners.clear()
  }
}

export type FakePtyFactory = {
  factory: (config: PtySpawnConfig) => PtyLike
  instances: FakePty[]
  failNext: (error: Error & { code?: string }) => void
}

export function createFakePtyFactory(): FakePtyFactory {
  FakePty.reset()
  let nextFailure: (Error & { code?: string }) | null = null
  return {
    factory: (config) => {
      if (nextFailure) {
        const error = nextFailure
        nextFailure = null
        throw error
      }
      return new FakePty(config)
    },
    instances: FakePty.instances,
    failNext: (error) => {
      nextFailure = error
    }
  }
}
