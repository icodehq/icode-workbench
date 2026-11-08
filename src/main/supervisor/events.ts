export type SupervisorEvent = {
  cursor: number
  kind: string
  repoId: string | null
  taskId: string | null
  at: number
}

type Waiter = {
  repoId: string
  after: number
  resolve: (cursor: number) => void
  timer: NodeJS.Timeout
}

/**
 * In-memory wake signal for `events.wait`.
 *
 * The supervisor does not need a replayable event stream in v1: on restart it
 * re-reads `state`, which is the durable truth. This log only answers "did
 * something change since cursor N?" so a shell command can block instead of
 * polling. Keeping it small also keeps it honest.
 */
export class SupervisorEventLog {
  private cursor = 0
  private readonly waiters = new Set<Waiter>()
  private readonly recent: SupervisorEvent[] = []

  constructor(private readonly now: () => number = () => Date.now()) {}

  record(input: { kind: string; repoId?: string | null; taskId?: string | null }): number {
    this.cursor += 1
    const event: SupervisorEvent = {
      cursor: this.cursor,
      kind: input.kind,
      repoId: input.repoId ?? null,
      taskId: input.taskId ?? null,
      at: this.now()
    }
    this.recent.push(event)
    if (this.recent.length > 50) this.recent.shift()
    for (const waiter of [...this.waiters]) {
      if (waiter.after < this.cursor && (event.repoId === null || event.repoId === waiter.repoId)) {
        this.settle(waiter)
      }
    }
    return this.cursor
  }

  current(): number {
    return this.cursor
  }

  since(after: number): SupervisorEvent[] {
    return this.recent.filter((event) => event.cursor > after)
  }

  wait(repoId: string, after: number, timeoutMs: number): Promise<number> {
    if (this.cursor > after) return Promise.resolve(this.cursor)
    const bounded = Math.max(1_000, Math.min(30_000, Math.trunc(timeoutMs)))
    return new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(this.cursor)
      }, bounded)
      timer.unref?.()
      const waiter: Waiter = {
        repoId,
        after,
        resolve: (cursor) => {
          this.waiters.delete(waiter)
          clearTimeout(waiter.timer)
          resolve(cursor)
        },
        timer
      }
      this.waiters.add(waiter)
    })
  }

  dispose(): void {
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer)
      waiter.resolve(this.cursor)
    }
    this.waiters.clear()
  }

  private settle(waiter: Waiter): void {
    this.waiters.delete(waiter)
    clearTimeout(waiter.timer)
    waiter.resolve(this.cursor)
  }
}
