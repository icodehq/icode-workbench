import {
  applyActivityEvent,
  applyPluginActivity,
  applyTerminalActivity,
  toActivitySummary,
  unknownActivity,
  ACTIVITY_MAX_EVENT_SKEW_MS,
  type ActivityHookEvent,
  type ActivitySummary,
  type AgentActivity,
  type PluginActivityEvent,
  type TerminalActivityEvent
} from '../../shared/domain/activity'
import { HARNESS_CAPABILITIES, type HarnessId } from '../../shared/domain/harness'

export type ActivityTransition = {
  sessionId: string
  previous: ActivitySummary
  next: ActivitySummary
  /** Harness conversation identity for Sleep/Wake; never shown as activity. */
  harnessSessionId: string | null
  /** A transition the user should be told about, at most once per logical change. */
  attention: 'done' | 'waiting' | null
}

/** A hook accepted within this window stays senior to terminal evidence. */
export const ACTIVITY_HOOK_SENIORITY_MS = 120_000

export type TerminalIngestResult =
  | 'accepted'
  | 'duplicate'
  | 'stale'
  | 'unknown-session'
  | 'stale-incarnation'
  | 'unsupported-harness'
  | 'app-mismatch'
  | 'hook-senior'
  | 'not-actionable'

export type PluginIngestResult =
  | 'accepted'
  | 'duplicate'
  | 'stale'
  | 'unknown-session'
  | 'stale-incarnation'
  | 'unsupported-harness'
  | 'shared-server'
  | 'disabled'

export type ActivityServiceOptions = {
  isKnownSession: (sessionId: string) => boolean
  /** The incarnation the session is currently bound to, if any. */
  currentIncarnation: (sessionId: string) => string | null
  now?: () => number
  onTransition?: (transition: ActivityTransition) => void
  onRejected?: (reason: string, event: Partial<ActivityHookEvent | PluginActivityEvent>) => void
  /** The managed-plugin channel can be turned off without unloading OpenCode. */
  pluginActivityEnabled?: () => boolean
}

type Entry = {
  activity: AgentActivity
  incarnationId: string | null
  lastSentAt: number
  /** Last accepted hook time; terminal evidence yields while this is recent. */
  lastHookAt: number
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
   * The harness conversation identity carried by the newest accepted hook.
   * Activity itself stays advisory and in-memory; SessionService persists this
   * one value so Sleep/Wake can resume the right conversation.
   */
  harnessSessionId(sessionId: string): string | null {
    return this.entries.get(sessionId)?.activity.claudeSessionId ?? null
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
    entry.lastHookAt = 0
    entry.seenPromptEvents.clear()
  }

  reset(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /**
   * Drops live plugin-derived activity without touching hook or terminal state.
   * Used when the managed integration is disabled while sessions are running.
   */
  invalidatePluginActivity(): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.activity.source !== 'plugin') continue
      const previous = entry.activity
      entry.activity = unknownActivity(this.now())
      this.options.onTransition?.({
        sessionId,
        previous: toActivitySummary(previous),
        next: toActivitySummary(entry.activity),
        harnessSessionId: entry.activity.claudeSessionId,
        attention: null
      })
    }
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
      harnessSessionId: entry.activity.claudeSessionId,
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
    if (!this.adoptIncarnation(entry, event.sessionId, event.incarnationId)) {
      this.options.onRejected?.('stale-incarnation', event)
      return 'stale-incarnation'
    }

    if (entry.lastSentAt > 0 && event.sentAt < entry.lastSentAt - ACTIVITY_MAX_EVENT_SKEW_MS) {
      this.options.onRejected?.('stale-event', event)
      return 'stale'
    }
    // A valid hook proves the hook channel is alive even when the event is a duplicate.
    entry.lastHookAt = this.now()

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
      harnessSessionId: next.claudeSessionId,
      attention
    })
    return alreadySeen ? 'duplicate' : 'accepted'
  }

  /**
   * Terminal evidence shares the hook ordering rules: unknown sessions and a
   * replaced incarnation are rejected, and a first event must match the live
   * process. Hooks stay senior for a short window, except for a blocked prompt,
   * which is exactly what a human needs to see.
   */
  ingestTerminal(event: TerminalActivityEvent): TerminalIngestResult {
    if (!this.options.isKnownSession(event.sessionId)) return 'unknown-session'
    if (!HARNESS_CAPABILITIES[event.harness].activity[event.source]) {
      return 'unsupported-harness'
    }
    if (event.source === 'program' && event.app !== undefined) {
      const app = appHarness(event.app)
      if (app !== null && app !== event.harness) return 'app-mismatch'
    }

    const entry = this.entryFor(event.sessionId)
    if (!this.adoptIncarnation(entry, event.sessionId, event.incarnationId)) {
      return 'stale-incarnation'
    }

    const now = this.now()
    const previous = entry.activity
    const hookRecent =
      entry.lastHookAt > 0 && now - entry.lastHookAt <= ACTIVITY_HOOK_SENIORITY_MS
    if (hookRecent && event.state !== 'waiting') return 'hook-senior'
    // A spinner can lag behind a permission prompt; never clear a wait with it.
    if (event.state === 'working' && previous.state === 'waiting') return 'not-actionable'

    const next = applyTerminalActivity(previous, event, now)
    if (sameActivity(previous, next)) return 'duplicate'
    entry.activity = next
    this.options.onTransition?.({
      sessionId: event.sessionId,
      previous: toActivitySummary(previous),
      next: toActivitySummary(next),
      harnessSessionId: next.claudeSessionId,
      attention: terminalAttention(previous, next)
    })
    return 'accepted'
  }

  /**
   * Applies a full snapshot from the managed OpenCode plugin.
   *
   * Plugin evidence is precise, so it is not made to yield to a recent hook the
   * way terminal evidence is; it is still restricted to the live incarnation and
   * ordered by `sentAt`. Shared-server posts without a TUI pane claim are ignored
   * until a binder exists, rather than being attributed to the wrong session.
   */
  ingestPlugin(event: PluginActivityEvent): PluginIngestResult {
    if (!this.options.isKnownSession(event.sessionId)) {
      this.options.onRejected?.('unknown-session', event)
      return 'unknown-session'
    }
    if (!HARNESS_CAPABILITIES[event.harness].activity.plugin) {
      this.options.onRejected?.('unsupported-harness', event)
      return 'unsupported-harness'
    }
    if (event.sharedServer === true) return 'shared-server'
    if (this.options.pluginActivityEnabled?.() === false) return 'disabled'

    const entry = this.entryFor(event.sessionId)
    if (!this.adoptIncarnation(entry, event.sessionId, event.incarnationId)) {
      this.options.onRejected?.('stale-incarnation', event)
      return 'stale-incarnation'
    }
    if (entry.lastSentAt > 0 && event.sentAt < entry.lastSentAt - ACTIVITY_MAX_EVENT_SKEW_MS) {
      this.options.onRejected?.('stale-event', event)
      return 'stale'
    }

    entry.lastSentAt = Math.max(entry.lastSentAt, event.sentAt)
    const previous = entry.activity
    const next = applyPluginActivity(previous, event, this.now())
    if (sameActivity(previous, next)) return 'duplicate'

    entry.activity = next
    this.options.onTransition?.({
      sessionId: event.sessionId,
      previous: toActivitySummary(previous),
      next: toActivitySummary(next),
      harnessSessionId: next.claudeSessionId,
      attention: pluginAttention(previous, next)
    })
    return 'accepted'
  }

  private adoptIncarnation(
    entry: Entry,
    sessionId: string,
    incarnationId: string
  ): boolean {
    const current = this.options.currentIncarnation(sessionId)
    if (entry.incarnationId !== null && incarnationId !== entry.incarnationId) return false
    if (entry.incarnationId === null) {
      // First evidence for this session: adopt it only if it matches the live process.
      if (current === null || current !== incarnationId) return false
      entry.incarnationId = incarnationId
    }
    return true
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
      lastHookAt: 0,
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
    left.source === right.source &&
    left.promptId === right.promptId &&
    left.prompt === right.prompt &&
    left.message === right.message &&
    left.attentionKind === right.attentionKind &&
    sameSubagents(left.subagents, right.subagents)
  )
}

function sameSubagents(
  left: AgentActivity['subagents'],
  right: AgentActivity['subagents']
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (
      a.id !== b.id ||
      a.label !== b.label ||
      a.state !== b.state ||
      a.toolName !== b.toolName ||
      a.kind !== b.kind
    ) {
      return false
    }
  }
  return true
}

/** Program `app` ids whose iCode harness id differs. */
function appHarness(app: string): HarnessId | null {
  switch (app) {
    case 'claude':
    case 'claude-code':
      return 'claude'
    case 'codex':
      return 'codex'
    case 'opencode':
    case 'opencode2':
      return 'opencode'
    default:
      return null
  }
}

function pluginAttention(
  previous: AgentActivity,
  next: AgentActivity
): ActivityTransition['attention'] {
  if (next.state === 'waiting' && previous.state !== 'waiting') return 'waiting'
  if (
    next.state === 'idle' &&
    next.outcome !== null &&
    (previous.state !== 'idle' || previous.outcome !== next.outcome)
  ) {
    return 'done'
  }
  return null
}

function terminalAttention(
  previous: AgentActivity,
  next: AgentActivity
): ActivityTransition['attention'] {
  if (next.state === 'waiting' && previous.state !== 'waiting') return 'waiting'
  if (
    next.state === 'idle' &&
    next.outcome !== null &&
    (previous.state !== 'idle' || previous.outcome !== next.outcome)
  ) {
    return 'done'
  }
  return null
}
