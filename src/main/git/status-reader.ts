/**
 * Reads `git status --porcelain=v2 --branch -z`.
 *
 * The v2 format answers branch, upstream, ahead/behind and every path in one
 * call, so a status refresh no longer pays for four separate Git processes.
 * Parsing is incremental because a chunk boundary can fall inside a NUL record
 * (and, for a rename, between the new path and its origin).
 *
 * Per-file additions/deletions are deliberately absent. A full numstat pass is
 * much more expensive than status at scale (see the Phase 0 spike), so stats are
 * a separate, lazy read. Callers that need them must ask for them.
 */

import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import {
  areaForCode,
  statusForCode,
  type GitStatusEntry,
  type GitWorkspaceStatus
} from '../../shared/domain/git-workspace'

export const DEFAULT_STATUS_LIMIT = 10_000

/**
 * `GIT_OPTIONAL_LOCKS=0` (set by both executors) keeps a read from creating
 * `.git/index.lock`, which would make the live Agent's next Git command fail.
 * `--no-optional-locks` is a global Git option, so it cannot live in this
 * subcommand argv without hiding the subcommand from read-only retry checks.
 */
export const STATUS_V2_ARGS = [
  'status',
  '--porcelain=v2',
  '--branch',
  '-z',
  '--untracked-files=all'
] as const

export type GitBranchHeader = {
  branch: string | null
  headOid: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export type ParsedRepositoryStatus = GitWorkspaceStatus & {
  /** Unique paths Git reported, before the limit stopped the read. */
  statusLength: number
  /** True when a record after the limit was not read. */
  didHitLimit: boolean
  /** Opaque stamp for this status content; changes when paths or codes change. */
  revision: string
}

export type PorcelainV2Options = {
  limit?: number
}

/**
 * Incremental NUL-record parser.
 *
 * `push` accepts bytes or text and returns `false` once the limit has been
 * reached, so a streaming caller can stop the Git process instead of buffering
 * a status it will not display.
 */
export class PorcelainV2Parser {
  private readonly limit: number
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private readonly entries: GitStatusEntry[] = []
  private readonly paths = new Set<string>()
  private readonly header: GitBranchHeader = {
    branch: null,
    headOid: null,
    upstream: null,
    ahead: 0,
    behind: 0
  }
  private statusLength = 0
  private didHitLimit = false
  private stopped = false
  private pendingRename: { path: string; entries: GitStatusEntry[] } | null = null
  private finished = false

  constructor(options: PorcelainV2Options = {}) {
    const limit = options.limit ?? DEFAULT_STATUS_LIMIT
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_STATUS_LIMIT
  }

  get limitReached(): boolean {
    return this.stopped
  }

  push(chunk: string | Buffer): boolean {
    if (this.finished || this.stopped) return false
    // A chunk can end mid-codepoint. Decoding each chunk independently would
    // corrupt a non-ASCII path and shift every record after it.
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)

    let separator = this.pending.indexOf('\u0000')
    while (separator !== -1) {
      const record = this.pending.slice(0, separator)
      this.pending = this.pending.slice(separator + 1)
      this.consume(record)
      if (this.stopped) return false
      separator = this.pending.indexOf('\u0000')
    }
    return true
  }

  finish(): ParsedRepositoryStatus {
    this.finished = true
    if (!this.stopped) {
      this.pending += this.decoder.end()
      if (this.pending.length > 0) {
        const remaining = this.pending.split('\u0000')
        this.pending = ''
        for (const record of remaining) {
          if (record.length === 0 || this.stopped) continue
          this.consume(record)
        }
      }
    }
    const staged: GitStatusEntry[] = []
    const unstaged: GitStatusEntry[] = []
    const untracked: GitStatusEntry[] = []
    const conflicted: GitStatusEntry[] = []
    for (const entry of this.entries) {
      if (entry.area === 'staged') staged.push(entry)
      else if (entry.area === 'unstaged') unstaged.push(entry)
      else if (entry.area === 'untracked') untracked.push(entry)
      else conflicted.push(entry)
    }
    return {
      ...this.header,
      staged,
      unstaged,
      untracked,
      conflicted,
      clean: this.entries.length === 0,
      statusLength: this.statusLength,
      didHitLimit: this.didHitLimit,
      revision: this.revision()
    }
  }

  private consume(record: string): void {
    if (this.pendingRename !== null) {
      // The record after a `2` line is the rename origin, even when the limit
      // has just been reached. It has no status code of its own.
      const oldPath = record.length > 0 ? record : null
      for (const entry of this.pendingRename.entries) {
        if (entry.area === 'staged') entry.oldPath = oldPath
      }
      this.pendingRename = null
      return
    }
    if (record.length === 0) return
    if (record.startsWith('# ')) {
      this.consumeHeader(record.slice(2))
      return
    }
    if (record.startsWith('? ')) {
      this.addPath(record, [{ path: record.slice(2), oldPath: null, code: '??', area: 'untracked', status: 'untracked' }])
      return
    }
    if (record.startsWith('! ')) {
      // Ignored files are not part of the working-tree list.
      return
    }
    if (record.startsWith('1 ')) {
      this.consumeOrdinary(record)
      return
    }
    if (record.startsWith('2 ')) {
      this.consumeRename(record)
      return
    }
    if (record.startsWith('u ')) {
      this.consumeUnmerged(record)
    }
  }

  private consumeHeader(payload: string): void {
    const separator = payload.indexOf(' ')
    const key = separator === -1 ? payload : payload.slice(0, separator)
    const value = separator === -1 ? '' : payload.slice(separator + 1)
    if (key === 'branch.oid') {
      this.header.headOid = value === '(initial)' || value.length === 0 ? null : value
      return
    }
    if (key === 'branch.head') {
      this.header.branch = value === '(detached)' || value.length === 0 ? null : value
      return
    }
    if (key === 'branch.upstream') {
      this.header.upstream = value.length === 0 ? null : value
      return
    }
    if (key === 'branch.ab') {
      const match = /^\+(\d+)\s+-(\d+)$/u.exec(value)
      if (match) {
        this.header.ahead = Number.parseInt(match[1]!, 10)
        this.header.behind = Number.parseInt(match[2]!, 10)
      }
    }
  }

  private consumeOrdinary(record: string): void {
    // `1 XY sub mH mI mW hH hI path`; the path is the remainder and may contain spaces.
    const fields = record.split(' ')
    const path = fields.slice(8).join(' ')
    if (path.length === 0) return
    const xy = fields[1] ?? '..'
    const entries: GitStatusEntry[] = []
    const indexStatus = xy[0] ?? '.'
    const worktreeStatus = xy[1] ?? '.'
    if (indexStatus !== '.' && indexStatus !== ' ') {
      const code = `${indexStatus} `
      entries.push({ path, oldPath: null, code, area: 'staged', status: statusForCode(code) })
    }
    if (worktreeStatus !== '.' && worktreeStatus !== ' ') {
      const code = ` ${worktreeStatus}`
      entries.push({ path, oldPath: null, code, area: areaForCode(code), status: statusForCode(code) })
    }
    this.addPath(path, entries)
  }

  private consumeRename(record: string): void {
    // `2 XY sub mH mI mW hH hI Xscore path`; the origin arrives as the next record.
    const fields = record.split(' ')
    const path = fields.slice(9).join(' ')
    if (path.length === 0) return
    const xy = fields[1] ?? '..'
    const entries: GitStatusEntry[] = []
    const indexStatus = xy[0] ?? '.'
    const worktreeStatus = xy[1] ?? '.'
    if (indexStatus !== '.' && indexStatus !== ' ') {
      const code = `${indexStatus} `
      entries.push({ path, oldPath: null, code, area: 'staged', status: statusForCode(code) })
    }
    if (worktreeStatus !== '.' && worktreeStatus !== ' ') {
      const code = ` ${worktreeStatus}`
      entries.push({ path, oldPath: null, code, area: areaForCode(code), status: statusForCode(code) })
    }
    if (entries.length === 0) return
    this.countPath(path)
    if (this.stopped) return
    for (const entry of entries) this.entries.push(entry)
    this.pendingRename = { path, entries }
  }

  private consumeUnmerged(record: string): void {
    // `u XY sub m1 m2 m3 mW h1 h2 h3 path`
    const fields = record.split(' ')
    const path = fields.slice(10).join(' ')
    if (path.length === 0) return
    const xy = fields[1] ?? 'UU'
    this.addPath(path, [
      { path, oldPath: null, code: xy, area: 'conflicted', status: statusForCode(xy) }
    ])
  }

  private addPath(path: string, entries: GitStatusEntry[]): void {
    if (this.paths.has(path)) {
      // v2 emits one record per path. A duplicate would be a malformed stream;
      // keep the first record rather than double-counting the limit.
      return
    }
    this.countPath(path)
    if (this.stopped) return
    for (const entry of entries) this.entries.push(entry)
  }

  private countPath(path: string): void {
    if (this.paths.has(path)) return
    if (this.statusLength >= this.limit) {
      this.didHitLimit = true
      this.stopped = true
      return
    }
    this.paths.add(path)
    this.statusLength += 1
  }

  private revision(): string {
    const payload = JSON.stringify({
      branch: this.header.branch,
      headOid: this.header.headOid,
      upstream: this.header.upstream,
      ahead: this.header.ahead,
      behind: this.header.behind,
      entries: this.entries.map((entry) => [entry.area, entry.code, entry.path, entry.oldPath])
    })
    return createHash('sha1').update(payload).digest('hex').slice(0, 16)
  }
}

export function parsePorcelainV2(
  output: string,
  options: PorcelainV2Options = {}
): ParsedRepositoryStatus {
  const parser = new PorcelainV2Parser(options)
  parser.push(output)
  return parser.finish()
}
