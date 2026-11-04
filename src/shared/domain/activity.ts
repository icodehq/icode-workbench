/**
 * Per-session agent activity, derived only from Claude Code hooks.
 *
 * This is advisory and deliberately separate from `SessionLifecycleState`:
 * lifecycle answers "is the process alive", activity answers "what is the agent
 * doing". Activity never influences reconciliation, exit handling, or PTY
 * ownership, and `unknown` is a first-class answer rather than a guess.
 */

export const ACTIVITY_STATES = ['unknown', 'idle', 'working', 'waiting'] as const
export type ActivityState = (typeof ACTIVITY_STATES)[number]

export const ACTIVITY_OUTCOMES = ['completed', 'failed'] as const
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number]

/** Claude's structured hook events iCode consumes. `Notification` is intentionally absent. */
export const ACTIVITY_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure'
] as const
export type ActivityEventName = (typeof ACTIVITY_EVENTS)[number]

/** Tools where Claude is explicitly asking the user something, not running work. */
export const USER_INPUT_TOOLS = ['AskUserQuestion', 'ExitPlanMode'] as const

export const ACTIVITY_MAX_PAYLOAD_BYTES = 8 * 1024
export const ACTIVITY_HOOK_DEADLINE_MS = 100
/**
 * Events older than this relative to the newest accepted event are rejected as
 * delayed. Hooks and main share one clock, so the window only needs to absorb
 * concurrent delivery of events emitted in the same millisecond burst; a Stop
 * that arrives seconds late is exactly the case that must not win.
 */
export const ACTIVITY_MAX_EVENT_SKEW_MS = 250

export type ActivityHookEvent = {
  event: ActivityEventName
  /** iCode identity, injected into the PTY environment by the Host. */
  sessionId: string
  incarnationId: string
  /** Claude's own identifiers, used to reject stale turns when present. */
  claudeSessionId: string | null
  promptId: string | null
  toolName: string | null
  /** Monotonic-per-process send time, used only for ordering. */
  sentAt: number
}

export type AgentActivity = {
  state: ActivityState
  toolName: string | null
  /** Epoch ms of the last accepted transition. */
  since: number
  unread: boolean
  outcome: ActivityOutcome | null
  /** Claude session that produced the evidence, when known. */
  claudeSessionId: string | null
  /** Newest accepted prompt/turn id, used to reject delayed events. */
  promptId: string | null
}

export type ActivitySummary = {
  state: ActivityState
  toolName: string | null
  unread: boolean
  outcome: ActivityOutcome | null
  since: number
}

export function unknownActivity(now = Date.now()): AgentActivity {
  return {
    state: 'unknown',
    toolName: null,
    since: now,
    unread: false,
    outcome: null,
    claudeSessionId: null,
    promptId: null
  }
}

export function toActivitySummary(activity: AgentActivity): ActivitySummary {
  return {
    state: activity.state,
    toolName: activity.toolName,
    unread: activity.unread,
    outcome: activity.outcome,
    since: activity.since
  }
}

export function isUserInputTool(toolName: string | null): boolean {
  return toolName !== null && (USER_INPUT_TOOLS as readonly string[]).includes(toolName)
}

/**
 * State after a single hook event, given the activity it applies to.
 *
 * Ordering rules are enforced by the service before this function runs; this
 * only maps evidence to state. Tool completion deliberately keeps `working`:
 * a turn ends on `Stop`, not on a tool returning.
 */
export function applyActivityEvent(
  previous: AgentActivity,
  event: ActivityHookEvent,
  now: number
): AgentActivity {
  const base: AgentActivity = {
    ...previous,
    since: now,
    claudeSessionId: event.claudeSessionId ?? previous.claudeSessionId,
    promptId: event.promptId ?? previous.promptId
  }

  switch (event.event) {
    case 'SessionStart':
      return { ...base, state: 'idle', toolName: null, outcome: null, unread: previous.unread }
    case 'UserPromptSubmit':
      return { ...base, state: 'working', toolName: null, outcome: null }
    case 'PreToolUse': {
      if (isUserInputTool(event.toolName)) {
        return { ...base, state: 'waiting', toolName: event.toolName, outcome: null, unread: true }
      }
      return { ...base, state: 'working', toolName: event.toolName, outcome: null }
    }
    case 'PostToolUse':
      return { ...base, state: 'working', toolName: event.toolName ?? previous.toolName, outcome: null }
    case 'PostToolUseFailure':
      return { ...base, state: 'working', toolName: event.toolName ?? previous.toolName, outcome: null }
    case 'PermissionRequest':
      return {
        ...base,
        state: 'waiting',
        toolName: event.toolName ?? previous.toolName,
        outcome: null,
        unread: true
      }
    case 'Stop':
      return { ...base, state: 'idle', toolName: null, outcome: 'completed', unread: true }
    case 'StopFailure':
      return { ...base, state: 'idle', toolName: null, outcome: 'failed', unread: true }
    default:
      return previous
  }
}
