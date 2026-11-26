import type { TaskStore } from '../tasks/task-store'

export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string }

export type PendingPermission = {
  id: string
  sessionId: string
  taskId: string
  groupId: string
  toolName: string | null
  input: string | null
  createdAt: number
}

type Entry = PendingPermission & {
  promise: Promise<PermissionDecision | null>
  resolve: (decision: PermissionDecision | null) => void
  timer: NodeJS.Timeout | null
}

const DEFAULT_HOLD_MS = 120_000

/**
 * Permission requests from a task's worker session.
 *
 * Only tasks that belong to a group are held: the group room has a dock that
 * can answer them. Every other request resolves null immediately, so Claude
 * asks in its own terminal exactly as it would without iCode.
 */
export class PermissionService {
  private readonly pending = new Map<string, Entry>()
  private readonly bySession = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private readonly holdMs: number

  constructor(
    private readonly deps: {
      tasks: TaskStore
      now: () => number
      newId: (prefix: string) => string
      holdMs?: number
    }
  ) {
    this.holdMs = deps.holdMs ?? DEFAULT_HOLD_MS
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A broken window must not block the worker.
      }
    }
  }

  /**
   * Holds a request for a group task. Returns null for anything the room
   * cannot answer, which lets the hook print `{}` and Claude ask normally.
   */
  request(input: {
    sessionId: string
    toolName: string | null
    input: string | null
  }): Promise<PermissionDecision | null> | null {
    const task = this.deps.tasks.findBySessionId(input.sessionId as never)
    if (task === null || task.groupId === null || task.archivedAt !== null) return null
    const existingId = this.bySession.get(input.sessionId)
    if (existingId !== undefined) {
      const existing = this.pending.get(existingId)
      if (existing !== undefined) return existing.promise
    }
    const id = this.deps.newId('permission')
    let resolve: (decision: PermissionDecision | null) => void = () => undefined
    const promise = new Promise<PermissionDecision | null>((done) => {
      resolve = done
    })
    const entry: Entry = {
      id,
      sessionId: input.sessionId,
      taskId: task.id,
      groupId: task.groupId,
      toolName: input.toolName,
      input: input.input,
      createdAt: this.deps.now(),
      promise,
      resolve,
      timer: null
    }
    entry.timer = setTimeout(() => this.settle(id, null), this.holdMs)
    entry.timer.unref?.()
    this.pending.set(id, entry)
    this.bySession.set(input.sessionId, id)
    this.emit()
    return promise
  }

  list(groupId?: string): PendingPermission[] {
    return [...this.pending.values()]
      .filter((entry) => groupId === undefined || entry.groupId === groupId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(({ promise: _promise, resolve: _resolve, timer: _timer, ...entry }) => entry)
  }

  respond(id: string, decision: PermissionDecision): boolean {
    return this.settle(id, decision)
  }

  /** A session that ended cannot use its answer; release the hook with `{}`. */
  cancelSession(sessionId: string): void {
    const id = this.bySession.get(sessionId)
    if (id !== undefined) this.settle(id, null)
  }

  stop(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, null)
  }

  private settle(id: string, decision: PermissionDecision | null): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    this.pending.delete(id)
    if (this.bySession.get(entry.sessionId) === id) this.bySession.delete(entry.sessionId)
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.resolve(decision)
    this.emit()
    return true
  }
}
