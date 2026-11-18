/**
 * OSC 7501 Program Status Protocol — the subset iCode reads.
 *
 * A program reports its own state in the terminal byte stream:
 *   ESC ] 7501 ; state=working:kind=permission:app=claude-code ST
 * A terminal advertises support by answering the probe:
 *   ESC ] 7501 ; ? ST
 *
 * The protocol is external (https://www.superlogical.com/rex/docs/build/program-status).
 * iCode only consumes the root record; child ids belong to a subagent model this
 * milestone does not have.
 */

export const PROGRAM_STATUS_OSC = 7501

/** Reply shape from the protocol revision this client implements. */
export const PROGRAM_STATUS_QUERY_REPLY =
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'

export const PROGRAM_STATUS_STATES = ['idle', 'working', 'done', 'blocked', 'error'] as const
export type ProgramStatusState = (typeof PROGRAM_STATUS_STATES)[number]

export const PROGRAM_STATUS_KINDS = ['permission', 'question', 'auth'] as const
export type ProgramStatusKind = (typeof PROGRAM_STATUS_KINDS)[number]

export type ProgramStatusReport = {
  state: ProgramStatusState
  kind?: ProgramStatusKind
  app?: string
}

export type ProgramStatusMessage =
  | { type: 'query' }
  | { type: 'report'; report: ProgramStatusReport }

const MAX_BODY_LENGTH = 4096
const MAX_APP_LENGTH = 64

function isState(value: string): value is ProgramStatusState {
  return (PROGRAM_STATUS_STATES as readonly string[]).includes(value)
}

function isKind(value: string): value is ProgramStatusKind {
  return (PROGRAM_STATUS_KINDS as readonly string[]).includes(value)
}

/**
 * Parses the body between `OSC 7501;` and its terminator.
 *
 * A record carrying a non-empty `id` is a child record and is ignored. Unknown
 * keys, `progress`, `title` and `msg` are skipped rather than rejected: the
 * protocol is additive and a future field must not hide the state.
 */
export function parseProgramStatusBody(body: string): ProgramStatusMessage | null {
  const trimmed = body.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_BODY_LENGTH) return null
  if (trimmed === '?') return { type: 'query' }

  let state: ProgramStatusState | null = null
  let kind: ProgramStatusKind | undefined
  let app: string | undefined
  let child = false

  for (const pair of trimmed.split(':')) {
    const equals = pair.indexOf('=')
    if (equals <= 0) continue
    const key = pair.slice(0, equals).trim()
    const value = pair.slice(equals + 1).trim()
    if (key === 'id') {
      if (value.length > 0) child = true
      continue
    }
    if (key === 'state' && isState(value)) state = value
    if (key === 'kind' && isKind(value)) kind = value
    if (key === 'app' && value.length > 0 && value.length <= MAX_APP_LENGTH) app = value
  }

  if (child || state === null) return null
  return {
    type: 'report',
    report: {
      state,
      ...(kind !== undefined ? { kind } : {}),
      ...(app !== undefined ? { app } : {})
    }
  }
}

export type TerminalTitleState = 'working' | 'waiting' | 'idle'

const BRAILLE_SPINNER = /[⠀-⣿]/u
const CLAUDE_IDLE_PREFIX = '✳'
const WAITING_TITLE =
  /action required|\bpermission (?:required|needed|request(?:ed)?)\b|\bwaiting for (?:you|input|approval)\b|do you want to|\(y\/n\)/iu

/**
 * Classifies a terminal title into the one state a title may prove.
 *
 * A title can show work in progress or a blocked prompt; it cannot prove a turn
 * completed. Callers keep `idle` as a display correction, never as a task outcome.
 */
export function classifyTerminalTitle(title: string): TerminalTitleState | null {
  const value = title.trim()
  if (value.length === 0) return null
  // A blocked prompt can sit under a still-spinning header; attention wins.
  if (WAITING_TITLE.test(value)) return 'waiting'
  if (BRAILLE_SPINNER.test(value)) return 'working'
  if (value.startsWith(CLAUDE_IDLE_PREFIX)) return 'idle'
  return null
}
