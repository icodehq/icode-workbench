import type { SessionService } from '../sessions/session-service'
import type { AppError } from '../../shared/domain/errors'
import type { SessionId } from '../../shared/domain/ids'
import {
  isActiveTaskStatus,
  isTerminalTaskStatus,
  type TaskRecord
} from '../../shared/domain/task'
import type { TaskStore } from './task-store'

export type TaskDispatcherDeps = {
  tasks: TaskStore
  sessions: SessionService
  now: () => number
  /** Reports a change the UI should re-read. */
  onChange: () => void
  /** Terminal state of a session, host-confirmed. */
  isSessionLive: (sessionId: string) => boolean
  sessionState: (sessionId: string) => { state: string; exitCode: number | null } | null
  /** The worktree a newly created session was given, for review after the fact. */
  sessionWorktree: (sessionId: string) => string | null
}

/**
 * The queue and its single pump.
 *
 * Three invariants drive this file:
 *
 *  1. **Persist before launching.** A task row is committed before any terminal
 *     exists, and `session_id` is written the instant a session is created —
 *     before the prompt is typed. A crash at any point therefore leaves a record
 *     that says how far it got, instead of a process nobody can account for.
 *
 *  2. **Exactly one launch per task.** The claim is a conditional UPDATE in
 *     SQLite (`WHERE status = 'queued'`), and only the caller that changed the
 *     row proceeds. The in-process `pumpRunning` flag is an optimisation that
 *     keeps the queue from being scanned from every event, not the guarantee.
 *
 *  3. **Completion is observed, never inferred from a spawn.** `create()`
 *     returning only means a PTY exists; the task stays `running` until the
 *     harness reports a turn end, the session exits, or the host says it failed.
 */
export class TaskDispatcher {
  private pumpRunning = false
  private pumpAgain = false
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: TaskDispatcherDeps) {}

  /**
   * Starts following session events.
   *
   * Every session event can change what a task should say (a turn ended, the
   * process exited), so the tracker and the pump share one listener.
   */
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.deps.sessions.subscribe((event) => {
      void this.onSessionEvent(event)
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Asks for a dispatch pass. Coalesced: a burst of task creations scans once. */
  kick(): void {
    if (this.pumpRunning) {
      this.pumpAgain = true
      return
    }
    void this.pump()
  }

  /** One dispatch pass. Public for tests and for the boot sequence. */
  async pump(): Promise<void> {
    if (this.pumpRunning) {
      this.pumpAgain = true
      return
    }
    this.pumpRunning = true
    try {
      do {
        this.pumpAgain = false
        const max = this.deps.tasks.maxConcurrent()
        let active = this.deps.tasks.countActive()
        // Oldest first: the queue is FIFO, and a task that cannot start must not
        // be skipped in favour of a newer one unless capacity is the reason.
        for (;;) {
          if (active >= max) break
          const next = this.deps.tasks.nextQueued()
          if (!next) break
          const claimed = this.deps.tasks.claim(next.id, this.deps.now())
          if (!claimed) continue // someone else won the claim; the next row is ours
          active += 1
          await this.dispatchOne(this.deps.tasks.findById(next.id) ?? next)
        }
      } while (this.pumpAgain)
    } finally {
      this.pumpRunning = false
    }
  }

  /**
   * Launches one claimed task.
   *
   * Failure at each step is recorded against the task rather than thrown: a
   * dispatch failure must not take the pump down with it, because the next
   * queued task is still startable.
   */
  private async dispatchOne(task: TaskRecord): Promise<void> {
    const now = this.deps.now()
    let sessionId: SessionId
    try {
      const summary = await this.deps.sessions.create({
        repoId: task.repoId,
        harness: task.harness,
        // The title is the task's own, so the sidebar and the queue agree.
        title: task.title,
        cols: 100,
        rows: 30
      })
      sessionId = summary.id as SessionId
    } catch (error) {
      this.fail(task, {
        reason: 'session-create-failed',
        message: 'The harness could not be started.',
        detail: messageOf(error)
      })
      return
    }

    // Record the session and its worktree BEFORE typing anything: from here on
    // the task is reviewable even if the write below fails.
    this.deps.tasks.updateIfStatus(
      task.id,
      ['dispatching'],
      {
        status: 'running',
        sessionId,
        worktreePath: this.sessionWorktreePath(sessionId),
        startedAt: now,
        lastObservedState: 'live'
      },
      this.deps.now()
    )
    this.deps.onChange()

    try {
      const incarnation = await this.currentIncarnation(sessionId)
      await this.deps.sessions.write(sessionId, incarnation, `${task.prompt}\r`)
    } catch (error) {
      this.fail(task, {
        reason: 'prompt-write-failed',
        message: 'The session started but the instruction could not be delivered.',
        detail: `${messageOf(error)} Open the session to send it by hand.`,
        sessionId
      })
      return
    }

    // The write landing is not completion — the task stays `running` until the
    // harness reports a turn end or the process exits.
    this.deps.onChange()
    this.kick()
  }

  /**
   * Applies a session event to whatever task owns that session.
   *
   * The mapping is deliberately narrow: only states ADE can actually observe
   * are written, and an unrecognised event leaves the task alone rather than
   * guessing.
   */
  private async onSessionEvent(event: { type?: string; sessionId?: string }): Promise<void> {
    const sessionId = event.sessionId
    if (!sessionId) return
    const task = this.deps.tasks.list({ limit: 500 }).find((candidate) => candidate.sessionId === sessionId)
    if (!task || isTerminalTaskStatus(task.status)) return
    this.reconcileTask(task, this.deps.sessionState(sessionId))
    // A slot may have been freed.
    this.kick()
  }

  /**
   * Maps an observed session state onto a non-terminal task.
   *
   * `exited` with status 0 is a completion: the harness ran to the end and its
   * process ended cleanly with no failure signal. `exited` with a non-zero code
   * is a failure. `failed` is a failure. Nothing here can turn a task into
   * `completed` merely because a process exists.
   */
  reconcileTask(task: TaskRecord, observed: { state: string; exitCode: number | null } | null): void {
    if (isTerminalTaskStatus(task.status)) return
    const now = this.deps.now()
    if (!observed) {
      // The host cannot see the session at all. That is not an ending, it is a
      // disappearance — the restart path decides what that means.
      return
    }
    if (observed.state === 'live' || observed.state === 'starting') {
      if (task.status === 'waiting') {
        this.deps.tasks.updateIfStatus(task.id, ['waiting'], { status: 'running', lastObservedState: observed.state }, now)
      } else {
        this.deps.tasks.updateIfStatus(task.id, ['running', 'dispatching'], { lastObservedState: observed.state }, now)
      }
      return
    }
    if (observed.state === 'exited') {
      // An unknown code is not a clean one. ADE records the failure and says
      // why, rather than reporting a finished task it cannot vouch for.
      if (observed.exitCode === null) {
        this.deps.tasks.updateIfStatus(
          task.id,
          ['running', 'waiting', 'dispatching'],
          {
            status: 'failed',
            failureReason: 'harness-failed',
            lastObservedState: 'exited',
            finishedAt: now,
            error: 'The harness exited, but its exit code could not be read.',
            errorDetail: 'Open the session to read its last output.'
          },
          now
        )
        this.deps.onChange()
        return
      }
      if (observed.exitCode === 0) {
        this.deps.tasks.updateIfStatus(
          task.id,
          ['running', 'waiting', 'dispatching'],
          {
            status: 'completed',
            lastObservedState: 'exited',
            exitCode: 0,
            finishedAt: now,
            resultSummary: 'The harness exited cleanly.'
          },
          now
        )
      } else {
        this.deps.tasks.updateIfStatus(
          task.id,
          ['running', 'waiting', 'dispatching'],
          {
            status: 'failed',
            failureReason: 'harness-failed',
            lastObservedState: 'exited',
            exitCode: observed.exitCode,
            finishedAt: now,
            error: `The harness exited with code ${String(observed.exitCode ?? 'unknown')}.`,
            errorDetail: 'Open the session to read its last output.'
          },
          now
        )
      }
      this.deps.onChange()
      return
    }
    if (observed.state === 'failed') {
      this.deps.tasks.updateIfStatus(
        task.id,
        ['running', 'waiting', 'dispatching'],
        {
          status: 'failed',
          failureReason: 'harness-failed',
          lastObservedState: 'failed',
          finishedAt: now,
          error: 'The harness reported a failure.',
          errorDetail: 'Open the session to read its last output.'
        },
        now
      )
      this.deps.onChange()
    }
  }

  /**
   * Applies hook-derived activity to the owning task.
   *
   * This is the only signal that distinguishes "the agent finished a turn" from
   * "the agent is waiting for permission": both leave a live process behind.
   */
  onActivity(sessionId: string, activity: { state: string; outcome: string | null }): void {
    const task = this.deps.tasks
      .list({ limit: 500 })
      .find((candidate) => candidate.sessionId === sessionId)
    if (!task || isTerminalTaskStatus(task.status)) return
    const now = this.deps.now()
    if (activity.state === 'waiting' && isActiveTaskStatus(task.status)) {
      // The agent is blocked on a human. Not a failure, not progress — the user
      // has to look, so the queue says so instead of pretending it is working.
      this.deps.tasks.updateIfStatus(
        task.id,
        ['running', 'dispatching'],
        {
          status: 'waiting',
          lastObservedState: 'waiting',
          resultSummary: 'Waiting for your input in the session.'
        },
        now
      )
      this.deps.onChange()
      return
    }
    if (activity.state === 'working' && task.status === 'waiting') {
      // The user answered and the agent is working again: the slot was never
      // released, so this is a status correction rather than a new dispatch.
      this.deps.tasks.updateIfStatus(
        task.id,
        ['waiting'],
        { status: 'running', lastObservedState: 'working', resultSummary: null },
        now
      )
      this.deps.onChange()
      return
    }
    if (activity.state === 'idle' && activity.outcome === 'completed') {
      this.deps.tasks.updateIfStatus(
        task.id,
        ['running', 'waiting'],
        {
          status: 'completed',
          finishedAt: now,
          lastObservedState: 'live',
          resultSummary: 'The agent finished its turn. Review the worktree for the result.'
        },
        now
      )
      this.deps.onChange()
      this.kick()
      return
    }
    if (activity.state === 'idle' && activity.outcome === 'failed') {
      this.deps.tasks.updateIfStatus(
        task.id,
        ['running', 'waiting'],
        {
          status: 'failed',
          failureReason: 'harness-failed',
          finishedAt: now,
          error: 'The agent reported a failed turn.',
          errorDetail: 'Open the session to read the error.'
        },
        now
      )
      this.deps.onChange()
      this.kick()
    }
  }

  /**
   * Reconciles every task that was mid-flight when ADE last stopped.
   *
   * The rule is the same one Ceza's `reconcileLoadedRun` applies: a task that
   * was live in a process that no longer exists cannot have finished, so it is
   * failed as interrupted — never completed. A `dispatching` task with no
   * session never launched anything and is safe to re-queue.
   */
  async recover(): Promise<{ requeued: number; interrupted: number }> {
    let requeued = 0
    let interrupted = 0
    const now = this.deps.now()

    for (const task of this.deps.tasks.active()) {
      if (task.status === 'dispatching' && task.sessionId === null) {
        // The claim happened, nothing was launched. Re-queuing is honest and safe.
        const ok = this.deps.tasks.updateIfStatus(
          task.id,
          ['dispatching'],
          { status: 'queued', startedAt: null, lastObservedState: null },
          now
        )
        if (ok) requeued += 1
        continue
      }
      if (task.sessionId === null) {
        this.deps.tasks.updateIfStatus(
          task.id,
          ['dispatching', 'running', 'waiting'],
          {
            status: 'failed',
            failureReason: 'interrupted',
            finishedAt: now,
            error: 'Interrupted — ADE exited before the task started.',
            errorDetail: 'No session was recorded, so nothing was left running.'
          },
          now
        )
        interrupted += 1
        continue
      }

      // A session exists. Ask the host — the persisted row proves nothing.
      const observed = this.deps.sessionState(task.sessionId)
      const live = observed?.state === 'live' || observed?.state === 'starting'
      if (live) {
        // The terminal survived: adopt it rather than starting a second one.
        this.deps.tasks.updateIfStatus(
          task.id,
          ['dispatching', 'running', 'waiting'],
          {
            status: task.status === 'waiting' ? 'waiting' : 'running',
            lastObservedState: observed?.state ?? 'live'
          },
          now
        )
        continue
      }
      /*
       * Anything still active at startup is interrupted — even if the host now
       * reports a clean exit.
       *
       * That report was produced after this process died (the PTY died with
       * us, or the distro restarted), so it cannot be attributed to the task
       * finishing its work. If the harness HAD been observed exiting cleanly,
       * the tracker would have completed the task before the crash. Reporting
       * `completed` here would be the false finish AC-07 exists to prevent.
       */
      // Gone, exited, or exited badly: interrupted, and the worktree link kept.
      this.deps.tasks.updateIfStatus(
        task.id,
        ['dispatching', 'running', 'waiting'],
        {
          status: 'failed',
          failureReason: 'interrupted',
          finishedAt: now,
          error:
            observed?.state === 'exited'
              ? `Interrupted — the harness exited with code ${String(observed.exitCode ?? 'unknown')} while ADE was not running.`
              : 'Interrupted — ADE stopped while this task was running.',
          errorDetail: 'Open the session or review the worktree to see what was left behind.'
        },
        now
      )
      interrupted += 1
    }

    this.deps.onChange()
    this.kick()
    return { requeued, interrupted }
  }

  private fail(
    task: TaskRecord,
    input: {
      reason: 'session-create-failed' | 'prompt-write-failed'
      message: string
      detail: string
      sessionId?: SessionId
    }
  ): void {
    const now = this.deps.now()
    this.deps.tasks.updateIfStatus(
      task.id,
      ['dispatching', 'running'],
      {
        status: 'failed',
        failureReason: input.reason,
        finishedAt: now,
        error: input.message,
        errorDetail: input.detail,
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      },
      now
    )
    this.deps.onChange()
    this.kick()
  }

  private sessionWorktreePath(sessionId: SessionId): string | null {
    return this.deps.sessionWorktree(sessionId)
  }

  private async currentIncarnation(sessionId: SessionId): Promise<string> {
    const summary = await this.deps.sessions.get(sessionId)
    const incarnation = summary.incarnationId
    if (!incarnation) {
      throw new Error('The session has no incarnation to write to.')
    }
    return incarnation
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  const appError = error as AppError | undefined
  if (appError && typeof appError === 'object' && 'message' in appError) {
    return String(appError.message)
  }
  return String(error)
}
