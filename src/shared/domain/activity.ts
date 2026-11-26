/**
 * Per-session agent activity, from Claude hooks and in-band terminal evidence.
 *
 * This is advisory and deliberately separate from `SessionLifecycleState`:
 * lifecycle answers "is the process alive", activity answers "what is the agent
 * doing". Activity never influences reconciliation, exit handling, or PTY
 * ownership, and `unknown` is a first-class answer rather than a guess.
 */

import type { HarnessId } from './harness'
import type { ProgramStatusKind } from './program-status'

export const ACTIVITY_STATES = ['unknown', 'idle', 'working', 'waiting'] as const
export type ActivityState = (typeof ACTIVITY_STATES)[number]

export const ACTIVITY_OUTCOMES = ['completed', 'failed'] as const
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number]

export const ACTIVITY_SOURCES = ['hook', 'program', 'title', 'plugin', 'none'] as const
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]

export const ACTIVITY_ATTENTION_KINDS = ['permission', 'question'] as const
export type ActivityAttentionKind = (typeof ACTIVITY_ATTENTION_KINDS)[number]

export const ACTIVITY_SUBAGENT_STATES = ['working', 'waiting', 'idle', 'done'] as const
export type ActivitySubagentState = (typeof ACTIVITY_SUBAGENT_STATES)[number]

/** One child agent reported by an OpenCode-managed session. */
export type ActivitySubagent = {
  /** OpenCode child session id; stable for the child's lifetime. */
  id: string
  label: string
  state: ActivitySubagentState
  toolName: string | null
  kind: ActivityAttentionKind | null
}

export const PLUGIN_TEXT_MAX_LENGTH = 4_000
export const PLUGIN_SUBAGENTS_MAX = 32

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

/**
 * Tools where the agent is explicitly asking the user something, not running
 * work. Providers spell these differently (`ask_user_question`,
 * `ask_question`, `request_permission`), so matching normalizes punctuation
 * and case rather than keeping a provider-specific list.
 */
export const USER_INPUT_TOOLS = ['AskUserQuestion', 'ExitPlanMode'] as const
const USER_INPUT_NORMALIZED = new Set([
  'askuserquestion',
  'requestuserinput',
  'askquestion',
  'askpermission',
  'requestpermission',
  'exitplanmode'
])

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
  /** Bounded JSON of a PermissionRequest's tool input; never persisted. */
  toolInput: string | null
  /** True when the hook waits for a PermissionRequest decision on this socket. */
  permissionHold: boolean
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
  /** Which evidence class produced the current state. */
  source: ActivitySource
  /** Harness session that produced the evidence, when known (hooks only). */
  claudeSessionId: string | null
  /** Newest accepted prompt/turn id, used to reject delayed events. */
  promptId: string | null
  /** Last user prompt reported by a managed plugin, never persisted. */
  prompt: string | null
  /** Last assistant message reported by a managed plugin, never persisted. */
  message: string | null
  /** Why a plugin session is waiting, when it is. */
  attentionKind: ActivityAttentionKind | null
  /** Child agents reported by a managed plugin. */
  subagents: ActivitySubagent[]
}

export type ActivitySummary = {
  state: ActivityState
  toolName: string | null
  unread: boolean
  outcome: ActivityOutcome | null
  since: number
  source: ActivitySource
  prompt: string | null
  message: string | null
  attentionKind: ActivityAttentionKind | null
  subagents: ActivitySubagent[]
}

export function unknownActivity(now = Date.now()): AgentActivity {
  return {
    state: 'unknown',
    toolName: null,
    since: now,
    unread: false,
    outcome: null,
    source: 'none',
    claudeSessionId: null,
    promptId: null,
    prompt: null,
    message: null,
    attentionKind: null,
    subagents: []
  }
}

export function toActivitySummary(activity: AgentActivity): ActivitySummary {
  return {
    state: activity.state,
    toolName: activity.toolName,
    unread: activity.unread,
    outcome: activity.outcome,
    since: activity.since,
    source: activity.source,
    prompt: activity.prompt,
    message: activity.message,
    attentionKind: activity.attentionKind,
    subagents: activity.subagents
  }
}

export function isUserInputTool(toolName: string | null): boolean {
  return (
    toolName !== null &&
    USER_INPUT_NORMALIZED.has(toolName.replace(/[^a-z0-9]/gi, '').toLowerCase())
  )
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
    source: 'hook',
    claudeSessionId: event.claudeSessionId ?? previous.claudeSessionId,
    promptId: event.promptId ?? previous.promptId
  }

  switch (event.event) {
    case 'SessionStart':
      return {
        ...base,
        state: 'idle',
        toolName: null,
        outcome: null,
        unread: previous.unread,
        attentionKind: null
      }
    case 'UserPromptSubmit':
      return { ...base, state: 'working', toolName: null, outcome: null, attentionKind: null }
    case 'PreToolUse': {
      if (isUserInputTool(event.toolName)) {
        return {
          ...base,
          state: 'waiting',
          toolName: event.toolName,
          outcome: null,
          unread: true,
          attentionKind: 'question'
        }
      }
      return {
        ...base,
        state: 'working',
        toolName: event.toolName,
        outcome: null,
        attentionKind: null
      }
    }
    case 'PostToolUse':
      return {
        ...base,
        state: 'working',
        toolName: event.toolName ?? previous.toolName,
        outcome: null,
        attentionKind: null
      }
    case 'PostToolUseFailure':
      return {
        ...base,
        state: 'working',
        toolName: event.toolName ?? previous.toolName,
        outcome: null,
        attentionKind: null
      }
    case 'PermissionRequest':
      return {
        ...base,
        state: 'waiting',
        toolName: event.toolName ?? previous.toolName,
        outcome: null,
        unread: true,
        attentionKind: 'permission'
      }
    case 'Stop':
      return {
        ...base,
        state: 'idle',
        toolName: null,
        outcome: 'completed',
        unread: true,
        attentionKind: null
      }
    case 'StopFailure':
      return {
        ...base,
        state: 'idle',
        toolName: null,
        outcome: 'failed',
        unread: true,
        attentionKind: null
      }
    default:
      return previous
  }
}

export type TerminalActivityState = 'working' | 'waiting' | 'idle' | 'done' | 'error'

/** In-band evidence for one session; never carries a provider conversation id. */
export type TerminalActivityEvent = {
  sessionId: string
  harness: HarnessId
  incarnationId: string
  source: 'program' | 'title'
  state: TerminalActivityState
  kind?: ProgramStatusKind
  app?: string
  title?: string
  message?: string
  seq: number
}

/**
 * Maps terminal evidence to activity.
 *
 * Program reports are the agent's own words; `done` completes a turn and
 * `working -> idle` is Codex's turn-end shape. Title evidence is a correction
 * channel and never carries an outcome: a title cannot prove a turn finished.
 */
export function applyTerminalActivity(
  previous: AgentActivity,
  event: TerminalActivityEvent,
  now: number
): AgentActivity {
  const base: AgentActivity = {
    ...previous,
    since: now,
    source: event.source,
    attentionKind: null
  }

  if (event.source === 'title') {
    switch (event.state) {
      case 'working':
        return previous.state === 'waiting'
          ? previous
          : { ...base, state: 'working', toolName: null, outcome: null }
      case 'waiting':
        return { ...base, state: 'waiting', toolName: null, outcome: null, unread: true }
      case 'idle':
        return previous.state === 'working'
          ? { ...base, state: 'idle', toolName: null, outcome: null }
          : previous
      default:
        return previous
    }
  }

  switch (event.state) {
    case 'working':
      return { ...base, state: 'working', toolName: null, outcome: null }
    case 'waiting':
      return { ...base, state: 'waiting', toolName: null, outcome: null, unread: true }
    case 'done':
      return {
        ...base,
        state: 'idle',
        toolName: null,
        outcome: 'completed',
        unread: true,
        attentionKind: null
      }
    case 'error':
      return {
        ...base,
        state: 'idle',
        toolName: null,
        outcome: 'failed',
        unread: true,
        attentionKind: null
      }
    case 'idle':
      return previous.state === 'working'
        ? { ...base, state: 'idle', toolName: null, outcome: 'completed', unread: true }
        : { ...base, state: 'idle', toolName: null, outcome: null }
    default:
      return previous
  }
}

/** One child state as posted by the managed OpenCode plugin. */
export type PluginSubagent = {
  id: string
  label: string
  state: ActivitySubagentState
  toolName?: string | null
  kind?: ActivityAttentionKind
}

/**
 * A full status snapshot from the managed plugin.
 *
 * The plugin reports what it believes now, not an event stream: a late snapshot
 * from an older turn is rejected by `sentAt`, and a repeated snapshot is a
 * duplicate rather than a new notification.
 */
export type PluginActivityEvent = {
  sessionId: string
  harness: HarnessId
  incarnationId: string
  state: TerminalActivityState
  kind?: ActivityAttentionKind
  toolName?: string | null
  prompt?: string | null
  message?: string | null
  subagents?: PluginSubagent[]
  /** A server process report without a TUI pane claim; ignored in the first cut. */
  sharedServer?: true
  /** Plugin send time, used only to reject a snapshot older than the newest. */
  sentAt: number
  seq: number
}

/**
 * Maps a plugin snapshot to activity.
 *
 * A root can be quiet while a child still works (background subagents), so the
 * root display state is the aggregate of the two. Only the root carries an
 * outcome; a child can never complete the root turn.
 */
export function applyPluginActivity(
  previous: AgentActivity,
  event: PluginActivityEvent,
  now: number
): AgentActivity {
  const subagents = normalizePluginSubagents(event.subagents)
  const childWaiting = subagents.some((child) => child.state === 'waiting')
  const childWorking = subagents.some((child) => child.state === 'working')

  let state: ActivityState
  let outcome: ActivityOutcome | null = null
  let unread = previous.unread
  if (event.state === 'waiting' || childWaiting) {
    state = 'waiting'
    unread = true
  } else if (event.state === 'working' || childWorking) {
    state = 'working'
    unread = false
  } else if (event.state === 'done') {
    state = 'idle'
    outcome = 'completed'
    unread = true
  } else if (event.state === 'error') {
    state = 'idle'
    outcome = 'failed'
    unread = true
  } else {
    // A neutral idle snapshot is the plugin saying "no turn is running"; it
    // must not erase the verdict or unread attention of the turn that just
    // ended, and a genuinely new turn starts with a working snapshot first.
    state = 'idle'
    if (previous.state === 'idle') {
      outcome = previous.outcome
      unread = previous.unread
    }
  }

  return {
    ...previous,
    state,
    toolName: event.toolName ?? null,
    since: now,
    unread,
    outcome,
    source: 'plugin',
    prompt: event.prompt === undefined ? previous.prompt : capPluginText(event.prompt),
    message: event.message === undefined ? previous.message : capPluginText(event.message),
    attentionKind:
      state === 'waiting'
        ? (event.kind ??
          subagents.find((child) => child.state === 'waiting')?.kind ??
          null)
        : null,
    subagents
  }
}

export function normalizePluginSubagents(
  subagents: readonly PluginSubagent[] | undefined
): ActivitySubagent[] {
  if (subagents === undefined) return []
  const accepted: ActivitySubagent[] = []
  for (const child of subagents.slice(0, PLUGIN_SUBAGENTS_MAX)) {
    if (child.id.length === 0 || child.label.length === 0) continue
    accepted.push({
      id: child.id,
      label: child.label,
      state: child.state,
      toolName: child.toolName ?? null,
      kind: child.kind ?? null
    })
  }
  return accepted
}

/** Keeps a plugin preview within the same bound the wire contract enforces. */
export function capPluginText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  return value.length > PLUGIN_TEXT_MAX_LENGTH ? value.slice(0, PLUGIN_TEXT_MAX_LENGTH) : value
}
