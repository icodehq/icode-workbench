import {
  applyActivityEvent,
  toActivitySummary,
  unknownActivity,
  ACTIVITY_MAX_EVENT_SKEW_MS,
  type ActivityHookEvent,
  type ActivitySummary,
  type AgentActivity
} from '../../shared/domain/activity'

export type ActivityTransition = {
  sessionId: string
  previous: ActivitySummary
  next: ActivitySummary
  /** A transition the user should be told about, at most once per logical change. */
  attention: 'done' | 'waiting' | null
}

export type ActivityServiceOptions = {
  isKnownSession: (sessionId: string) => boolean
  /** The incarnation the session is currently bound to, if any. */
  currentIncarnation: (sessionId: string) => string | null
  now?: () => number
  onTransition?: (transition: ActivityTransition) => void
  onRejected?: (reason: string, event: Partial<ActivityHookEvent>) => void
}

type Entry = {
  activity: AgentActivity
  incarnationId: string | null
  lastSentAt: number
  /** Prompt ids already accepted, so a duplicate Stop cannot notify twice. */
  seenPromptEvents: Set<string>
}

/**
 * Authoritative activity state for live sessions.
 *
 * Ordering is enforced here rather than in the Hook script, because the socket
 * is the only place that can compare events for one session:
 *
 * 1. Unknown session, or an incarnation that is not the current one → rejected.
 * 2. `sentAt` older than the newest accepted event (minus a small skew window)
 *    → rejected, so a delayed `Stop` cannot overwrite a newer prompt.
 * 3. A duplicate `(event, promptId, toolName)` → treated as idempotent: state is
 *    reapplied only when it would change something, and never re-notifies.
 * 4. Otherwise the event is applied and the transition is emitted once.
 *
 * Activity is in-memory only: after a relaunch every session is `unknown`, which
 * is honest rather than a stale `working`.
 */
export class ActivityService {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number

  constructor(private readonly options: ActivityServiceOptions) {
    this.now = options.now ?? Date.now
  }

  get(sessionId: string): ActivitySummary {
    return toActivitySummary(this.entries.get(sessionId)?.activity ?? unknownActivity(this.now()))
  }

  list(): Array<{ sessionId: string; activity: ActivitySummary }> {
    return [...this.entries.entries()].map(([sessionId, entry]) => ({
      sessionId,
      activity: toActivitySummary(entry.activity)
    }))
  }

  /**
   * Binds the incarnation the session is now expected to report. Called after
   * create/attach/restart so events from a previous process are rejected.
   */
  bindIncarnation(sessionId: string, incarnationId: string | null): void {
    const entry = this.entryFor(sessionId)
    if (entry.incarnationId === incarnationId) return
    entry.incarnationId = incarnationId
    // A new process cannot continue the old turn.
    entry.activity = unknownActivity(this.now())
    entry.lastSentAt = 0
    entry.seenPromptEvents.clear()
  }

  reset(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /** Called when the session is selected in a focused window. Idempotent. */
  clearUnread(sessionId: string): boolean {
    const entry = this.entries.get(sessionId)
    if (!entry || !entry.activity.unread) return false
    const previous = entry.activity
    entry.activity = { ...entry.activity, unread: false }
    this.options.onTransition?.({
      sessionId,
      previous: toActivitySummary(previous),
      next: toActivitySummary(entry.activity),
      attention: null
    })
    return true
  }

  ingest(event: ActivityHookEvent): 'accepted' | 'duplicate' | 'stale' | 'unknown-session' | 'stale-incarnation' {
    if (!this.options.isKnownSession(event.sessionId)) {
      this.options.onRejected?.('unknown-session', event)
      return 'unknown-session'
    }
    const entry = this.entryFor(event.sessionId)
    const current = this.options.currentIncarnation(event.sessionId)

    if (entry.incarnationId !== null && event.incarnationId !== entry.incarnationId) {
      this.options.onRejected?.('stale-incarnation', event)
      return 'stale-incarnation'
    }
    if (entry.incarnationId === null) {
      // First evidence for this session: adopt it only if it matches the live process.
      if (current === null || current !== event.incarnationId) {
        this.options.onRejected?.('stale-incarnation', event)
        return 'stale-incarnation'
      }
      entry.incarnationId = event.incarnationId
    }

    if (entry.lastSentAt > 0 && event.sentAt < entry.lastSentAt - ACTIVITY_MAX_EVENT_SKEW_MS) {
      this.options.onRejected?.('stale-event', event)
      return 'stale'
    }

    const fingerprint = `${event.event}|${event.promptId ?? ''}|${event.toolName ?? ''}`
    const alreadySeen = entry.seenPromptEvents.has(fingerprint)
    entry.seenPromptEvents.add(fingerprint)
    // Bound the dedupe set: an agent can emit thousands of tool events per turn.
    if (entry.seenPromptEvents.size > 512) {
      const first = entry.seenPromptEvents.values().next().value
      if (first !== undefined) entry.seenPromptEvents.delete(first)
    }

    // A delayed Stop from the previous turn must not end the current one.
    if (
      event.promptId !== null &&
      entry.activity.promptId !== null &&
      event.event === 'Stop' &&
      event.promptId !== entry.activity.promptId
    ) {
      this.options.onRejected?.('stale-turn', event)
      return 'stale'
    }

    entry.lastSentAt = Math.max(entry.lastSentAt, event.sentAt)
    const previous = entry.activity
    const next = applyActivityEvent(previous, event, this.now())
    if (alreadySeen && sameActivity(previous, next)) {
      return 'duplicate'
    }
    entry.activity = next
    const attention = this.attentionFor(previous, next, event)
    this.options.onTransition?.({
      sessionId: event.sessionId,
      previous: toActivitySummary(previous),
      next: toActivitySummary(next),
      attention
    })
    return alreadySeen ? 'duplicate' : 'accepted'
  }

  private attentionFor(
    previous: AgentActivity,
    next: AgentActivity,
    event: ActivityHookEvent
  ): ActivityTransition['attention'] {
    if (event.event === 'Stop' || event.event === 'StopFailure') return 'done'
    if (event.event === 'PermissionRequest') return 'waiting'
    if (event.event === 'PreToolUse' && next.state === 'waiting') return 'waiting'
    // A repeated stop without new work is not a new completion.
    if (next.state === previous.state && next.unread === previous.unread) return null
    return null
  }

  private entryFor(sessionId: string): Entry {
    const existing = this.entries.get(sessionId)
    if (existing) return existing
    const entry: Entry = {
      activity: unknownActivity(this.now()),
      incarnationId: null,
      lastSentAt: 0,
      seenPromptEvents: new Set()
    }
    this.entries.set(sessionId, entry)
    return entry
  }
}

function sameActivity(left: AgentActivity, right: AgentActivity): boolean {
  return (
    left.state === right.state &&
    left.toolName === right.toolName &&
    left.outcome === right.outcome &&
    left.unread === right.unread &&
    left.promptId === right.promptId
  )
}
