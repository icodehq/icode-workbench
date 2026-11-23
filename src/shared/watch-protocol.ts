/**
 * Wire protocol between the Electron main process and the watcher child.
 *
 * Newline-delimited JSON over the child's stdio. The framing is deliberately
 * tiny and strict: the child can be killed by a malformed or oversized frame,
 * and every parser answers `null` instead of throwing. The protocol is private
 * to iCode (unlike the terminal Host protocol, which has external clients), so
 * it can evolve with the app and carries its own version.
 */

export const WATCH_PROTOCOL_VERSION = 1
export const WATCH_MAX_FRAME_BYTES = 1024 * 1024
export const WATCH_MAX_EVENTS_PER_FRAME = 512
export const WATCH_MAX_ROOTS = 512

export type WatchBackendName = 'parcel' | 'chokidar' | 'fswatch'

export const WATCH_EVENT_KINDS = ['add', 'addDir', 'change', 'unlink', 'unlinkDir'] as const
export type WatchEventKind = (typeof WATCH_EVENT_KINDS)[number]

/**
 * Everything the child needs to decide what to watch. Functions cannot cross a
 * process boundary, so the services serialize their rules instead.
 */
export type SerializedIgnore = {
  skipDirectories: string[]
  skipSuffixes: string[]
  /** e.g. `.icode-write-`; null when the watcher has no staging convention. */
  stagingMarker: string | null
}

export type SerializedWatchSpec = {
  kind: 'recursive' | 'shallow'
  /** Globally unique in the child: `files:<session>`, `git:<worktree>\0<gitDir>`. */
  id: string
  roots: string[]
  worktreePath: string
  ignore: SerializedIgnore
  /** Present for the Source Control watcher only. */
  git?: { worktreePath: string; gitDir: string }
}

export type ParentToWatcherMessage =
  | { t: 'sub'; rid: number; sub: string; spec: SerializedWatchSpec }
  | { t: 'roots'; rid: number; sub: string; roots: string[] }
  | { t: 'unsub'; rid: number; sub: string }
  | { t: 'ping'; rid: number }
  | { t: 'bye' }

export type WatcherToParentMessage =
  | { t: 'hello'; v: number; pid: number; backend: WatchBackendName }
  | {
      t: 'ok'
      rid: number
      bound?: number
      missing?: string[]
      backend?: WatchBackendName
    }
  | { t: 'ready'; sub: string }
  | { t: 'ev'; sub: string; events: [WatchEventKind, string][] }
  | { t: 'ovf'; sub: string }
  | { t: 'err'; rid?: number; sub?: string; code: string; msg: string }
  | { t: 'werr'; sub: string; root: string; code: string }
  | {
      t: 'stat'
      watches: number
      subs: number
      roots: number
      rss: number
      backend: WatchBackendName
    }
  | { t: 'pong'; rid: number }

export type WatchMessage = ParentToWatcherMessage | WatcherToParentMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isBackend(value: unknown): value is WatchBackendName {
  return value === 'parcel' || value === 'chokidar' || value === 'fswatch'
}

function isEventKind(value: unknown): value is WatchEventKind {
  return typeof value === 'string' && (WATCH_EVENT_KINDS as readonly string[]).includes(value)
}

function parseIgnore(value: unknown): SerializedIgnore | null {
  if (!isRecord(value)) return null
  const { skipDirectories, skipSuffixes, stagingMarker } = value
  if (!isStringArray(skipDirectories) || !isStringArray(skipSuffixes)) return null
  if (stagingMarker !== null && typeof stagingMarker !== 'string') return null
  return { skipDirectories, skipSuffixes, stagingMarker }
}

function parseSpec(value: unknown): SerializedWatchSpec | null {
  if (!isRecord(value)) return null
  const { kind, id, roots, worktreePath, ignore, git } = value
  if (kind !== 'recursive' && kind !== 'shallow') return null
  if (typeof id !== 'string' || id.length === 0) return null
  if (!isStringArray(roots) || roots.length > WATCH_MAX_ROOTS) return null
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return null
  const parsedIgnore = parseIgnore(ignore)
  if (parsedIgnore === null) return null
  if (git !== undefined) {
    if (!isRecord(git) || typeof git.worktreePath !== 'string' || typeof git.gitDir !== 'string') {
      return null
    }
    return {
      kind,
      id,
      roots,
      worktreePath,
      ignore: parsedIgnore,
      git: { worktreePath: git.worktreePath, gitDir: git.gitDir }
    }
  }
  return { kind, id, roots, worktreePath, ignore: parsedIgnore }
}

/** Serializes one message with its newline terminator. */
export function encodeWatchMessage(message: WatchMessage): string {
  return `${JSON.stringify(message)}\n`
}

/** Parses one child→parent frame. Returns null for anything malformed. */
export function parseWatcherMessage(raw: string): WatcherToParentMessage | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.t !== 'string') return null
  switch (value.t) {
    case 'hello':
      if (typeof value.v !== 'number' || typeof value.pid !== 'number' || !isBackend(value.backend)) {
        return null
      }
      return { t: 'hello', v: value.v, pid: value.pid, backend: value.backend }
    case 'ok': {
      if (typeof value.rid !== 'number') return null
      const bound = typeof value.bound === 'number' ? value.bound : undefined
      const missing = isStringArray(value.missing) ? value.missing : undefined
      const backend = isBackend(value.backend) ? value.backend : undefined
      return { t: 'ok', rid: value.rid, ...(bound !== undefined ? { bound } : {}), ...(missing !== undefined ? { missing } : {}), ...(backend !== undefined ? { backend } : {}) }
    }
    case 'ready':
      if (typeof value.sub !== 'string') return null
      return { t: 'ready', sub: value.sub }
    case 'ev': {
      if (typeof value.sub !== 'string' || !Array.isArray(value.events)) return null
      if (value.events.length > WATCH_MAX_EVENTS_PER_FRAME) return null
      const events: [WatchEventKind, string][] = []
      for (const entry of value.events) {
        if (!Array.isArray(entry) || entry.length !== 2) return null
        const [kind, path] = entry as [unknown, unknown]
        if (!isEventKind(kind) || typeof path !== 'string') return null
        events.push([kind, path])
      }
      return { t: 'ev', sub: value.sub, events }
    }
    case 'ovf':
      if (typeof value.sub !== 'string') return null
      return { t: 'ovf', sub: value.sub }
    case 'err':
      if (typeof value.code !== 'string' || typeof value.msg !== 'string') return null
      if (value.sub !== undefined && typeof value.sub !== 'string') return null
      if (value.rid !== undefined && typeof value.rid !== 'number') return null
      return {
        t: 'err',
        ...(value.rid !== undefined ? { rid: value.rid } : {}),
        ...(value.sub !== undefined ? { sub: value.sub } : {}),
        code: value.code,
        msg: value.msg
      }
    case 'werr':
      if (typeof value.sub !== 'string' || typeof value.root !== 'string' || typeof value.code !== 'string') {
        return null
      }
      return { t: 'werr', sub: value.sub, root: value.root, code: value.code }
    case 'stat':
      if (
        typeof value.watches !== 'number' ||
        typeof value.subs !== 'number' ||
        typeof value.roots !== 'number' ||
        typeof value.rss !== 'number' ||
        !isBackend(value.backend)
      ) {
        return null
      }
      return {
        t: 'stat',
        watches: value.watches,
        subs: value.subs,
        roots: value.roots,
        rss: value.rss,
        backend: value.backend
      }
    case 'pong':
      if (typeof value.rid !== 'number') return null
      return { t: 'pong', rid: value.rid }
    default:
      return null
  }
}

/** Parses one parent→child frame. Returns null for anything malformed. */
export function parseParentMessage(raw: string): ParentToWatcherMessage | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.t !== 'string') return null
  switch (value.t) {
    case 'sub': {
      if (typeof value.rid !== 'number' || typeof value.sub !== 'string') return null
      const spec = parseSpec(value.spec)
      if (spec === null) return null
      return { t: 'sub', rid: value.rid, sub: value.sub, spec }
    }
    case 'roots':
      if (typeof value.rid !== 'number' || typeof value.sub !== 'string') return null
      if (!isStringArray(value.roots) || value.roots.length > WATCH_MAX_ROOTS) return null
      return { t: 'roots', rid: value.rid, sub: value.sub, roots: value.roots }
    case 'unsub':
      if (typeof value.rid !== 'number' || typeof value.sub !== 'string') return null
      return { t: 'unsub', rid: value.rid, sub: value.sub }
    case 'ping':
      if (typeof value.rid !== 'number') return null
      return { t: 'ping', rid: value.rid }
    case 'bye':
      return { t: 'bye' }
    default:
      return null
  }
}
