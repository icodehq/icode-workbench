import type { GitWorkspaceContext } from '../workspace-context'
import type { GitOutcome } from '../git-workspace-service'
import {
  parseAheadBehind,
  type GitCommitDetail,
  type GitLogPage,
  type GitRangeFile
} from '../../../shared/domain/git-workspace'
import {
  EMPTY_TREE_OID,
  LOG_PRETTY_FORMAT,
  parseCommitMetadata,
  parseLogOutput
} from '../history-reader'
import { parseBlamePorcelain, type BlameLine } from '../blame-reader'
import { detailOf, parseNameStatusZ, parseNumstatZ, MAX_PATCH_BYTES } from '../git-helpers'
import { FILES_MAX_FILE_BYTES } from '../../../shared/domain/workspace-files'



  /**
   * Changed files between two revisions.
   *
   * Refs are resolved to commits before `diff` runs, so an arbitrary string is
   * never handed to Git as an option. The file list is bounded; the returned
   * `truncated` flag tells the history view to paginate instead of pretending
   * the range ended.
   */
export async function rangeDiff(ctx: GitWorkspaceContext, sessionId: string, from: string, to = 'HEAD'): Promise<GitOutcome<{ fromOid: string; toOid: string; commitCount: number; files: GitRangeFile[]; truncated: boolean }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved

    const resolveRef = async (ref: string): Promise<string | null> => {
      if (ref.length === 0 || ref.startsWith('-') || ref.includes('\u0000')) return null
      // A root commit is diffed against the empty tree, which is not a commit;
      // `^{commit}` would reject it.
      if (ref === EMPTY_TREE_OID) return EMPTY_TREE_OID
      return git(worktreePath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).catch(
        () => null
      )
    }
    const [fromOid, toOid] = await Promise.all([resolveRef(from), resolveRef(to)])
    if (fromOid === null || toOid === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That revision is not available in this worktree.'
      }
    }

    try {
      const [nameStatus, numstat, commitCountOutput] = await Promise.all([
        git(worktreePath, ['diff', '--name-status', '-z', '-M', fromOid, toOid, '--']),
        git(worktreePath, ['diff', '--numstat', '-z', '-M', fromOid, toOid, '--']),
        // The empty tree is a valid diff endpoint but not a commit, so it has
        // no revision range to count. A count failure must not fail the diff.
        fromOid === EMPTY_TREE_OID || toOid === EMPTY_TREE_OID
          ? Promise.resolve('0')
          : git(worktreePath, ['rev-list', '--count', `${fromOid}..${toOid}`]).catch(() => '0')
      ])
      const counted = Number.parseInt(commitCountOutput.trim(), 10)
      const commitCount = Number.isFinite(counted) && counted > 0 ? counted : 0
      const counts = new Map(parseNumstatZ(numstat).map((entry) => [entry.path, entry]))
      const files: GitRangeFile[] = parseNameStatusZ(nameStatus).map((entry) => {
        const count = counts.get(entry.path)
        const status =
          entry.status === 'A'
            ? 'added'
            : entry.status === 'D'
              ? 'deleted'
              : entry.status === 'R'
                ? 'renamed'
                : entry.status === 'C'
                  ? 'copied'
                  : 'modified'
        return {
          path: entry.path,
          oldPath: entry.oldPath,
          status,
          additions: count?.additions ?? null,
          deletions: count?.deletions ?? null,
          binary: count?.binary ?? false
        }
      })
      const limit = 5000
      return {
        status: 'ok',
        fromOid,
        toOid,
        commitCount,
        files: files.slice(0, limit),
        truncated: files.length > limit
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not compare those revisions.')
      }
    }
  }



  /**
   * Paginated History feed.
   *
   * Unlike `history()`, this returns full parent hashes, author dates and ref
   * decorations so the renderer can draw graph lanes and open a commit detail.
   * `ref` and `path` are validated before being passed to Git; the path is
   * always placed after `--` so a path that looks like a revision is inert.
   */
export async function log(ctx: GitWorkspaceContext, sessionId: string, options: {
      limit?: number
      skip?: number
      ref?: string
      path?: string
    } = {}): Promise<GitOutcome<GitLogPage>> {
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)))
    const skip = Math.min(100_000, Math.max(0, Math.floor(options.skip ?? 0)))
    const ref = options.ref?.trim() ?? ''
    if (
      ref.length > 0 &&
      (ref.startsWith('-') || ref.includes('\u0000') || ref.includes('\n'))
    ) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That revision is not valid.' }
    }
    const path = options.path?.trim() ?? ''
    if (
      path.length > 0 &&
      (path.includes('\u0000') ||
        path.startsWith('/') ||
        path.startsWith('-') ||
        path.split('/').includes('..'))
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That path is not valid for this worktree.'
      }
    }

    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    const headOid = await git(worktreePath, ['rev-parse', '--verify', 'HEAD']).catch(() => null)
    if (headOid === null) {
      return {
        status: 'ok',
        branch,
        headOid: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        commits: [],
        hasMore: false,
        nextSkip: skip
      }
    }

    const upstream = await git(worktreePath, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}'
    ]).catch(() => null)
    let ahead = 0
    let behind = 0
    if (upstream !== null) {
      const counts = await git(worktreePath, [
        'rev-list',
        '--left-right',
        '--count',
        `${upstream}...HEAD`
      ]).catch(() => null)
      if (counts !== null) {
        const parsed = parseAheadBehind(counts)
        ahead = parsed.ahead
        behind = parsed.behind
      }
    }

    const args = [
      'log',
      '--no-color',
      `-n${String(limit + 1)}`,
      `--skip=${String(skip)}`,
      '--date=unix',
      `--pretty=format:${LOG_PRETTY_FORMAT}`
    ]
    if (ref.length > 0) args.push(ref)
    args.push('--')
    if (path.length > 0) args.push(path)

    try {
      const output = await git(worktreePath, args)
      const all = parseLogOutput(output)
      const hasMore = all.length > limit
      const commits = hasMore ? all.slice(0, limit) : all
      return {
        status: 'ok',
        branch,
        headOid,
        upstream,
        ahead,
        behind,
        commits,
        hasMore,
        nextSkip: skip + commits.length
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read the commit history.')
      }
    }
  }




  /**
   * One commit's metadata plus the files of its first parent comparison.
   *
   * A root commit diffs against the empty tree. `rangeDiff` owns the file
   * parsing and the 5,000-file cap, so this method does not grow a second diff
   * parser.
   */
export async function commitDetail(ctx: GitWorkspaceContext, sessionId: string, oid: string, parent?: string): Promise<GitOutcome<GitCommitDetail>> {
    if (!/^[0-9a-f]{4,64}$/iu.test(oid)) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That commit id is not valid.' }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved

    let metadata
    try {
      const output = await git(worktreePath, [
        'show',
        '-s',
        '--no-patch',
        '--no-color',
        '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%B',
        oid
      ])
      metadata = parseCommitMetadata(output)
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read that commit.')
      }
    }
    if (metadata === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That commit is not available in this worktree.'
      }
    }

    if (parent !== undefined && !metadata.parents.includes(parent)) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That revision is not a parent of this commit.'
      }
    }
    const parentOid = parent ?? metadata.parents[0] ?? null
    const diff = await rangeDiff(ctx, sessionId, parentOid ?? EMPTY_TREE_OID, metadata.oid)
    if (diff.status !== 'ok') return diff
    let additions = 0
    let deletions = 0
    for (const file of diff.files) {
      additions += file.additions ?? 0
      deletions += file.deletions ?? 0
    }
    return {
      status: 'ok',
      ...metadata,
      parentOid,
      files: diff.files,
      additions,
      deletions,
      truncated: diff.truncated
    }
  }




  /**
   * Unified diff for one file between two revisions.
   *
   * History reuses the review renderer instead of growing a second diff view.
   * The patch is capped and binary output is reported explicitly; renames pass
   * both paths so Git can pair them.
   */
export async function revisionFileDiff(ctx: GitWorkspaceContext, sessionId: string, from: string, to: string, path: string, oldPath?: string): Promise<
    GitOutcome<{
      patch: string
      truncated: boolean
      binary: boolean
      additions: number | null
      deletions: number | null
      fromOid: string
      toOid: string
    }>
  > {
    const validRef = (ref: string): boolean =>
      ref.length > 0 && !ref.startsWith('-') && !ref.includes('\u0000') && !ref.includes('\n')
    if (!validRef(from) || !validRef(to)) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That revision is not valid.' }
    }
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').includes('..')
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That path is not valid for this worktree.'
      }
    }

    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const resolveRef = async (ref: string): Promise<string | null> => {
      if (ref === EMPTY_TREE_OID) return EMPTY_TREE_OID
      return git(worktreePath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).catch(
        () => null
      )
    }
    const [fromOid, toOid] = await Promise.all([resolveRef(from), resolveRef(to)])
    if (fromOid === null || toOid === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That revision is not available in this worktree.'
      }
    }

    const paths = oldPath !== undefined && oldPath !== path ? [oldPath, path] : [path]
    try {
      const output = await git(worktreePath, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '-M',
        '--unified=3',
        fromOid,
        toOid,
        '--',
        ...paths
      ])
      const binary = output.includes('Binary files ') || output.includes('GIT binary patch')
      if (binary) {
        return {
          status: 'ok',
          patch: output,
          truncated: false,
          binary: true,
          additions: null,
          deletions: null,
          fromOid,
          toOid
        }
      }
      let additions = 0
      let deletions = 0
      let inHunk = false
      for (const line of output.split('\n')) {
        if (line.startsWith('@@')) {
          inHunk = true
          continue
        }
        if (!inHunk || line.startsWith('\\')) continue
        if (line.startsWith('+')) additions += 1
        else if (line.startsWith('-')) deletions += 1
      }
      const bytes = Buffer.from(output, 'utf8')
      const truncated = bytes.byteLength > MAX_PATCH_BYTES
      return {
        status: 'ok',
        patch: truncated ? bytes.subarray(0, MAX_PATCH_BYTES).toString('utf8') : output,
        truncated,
        binary: false,
        additions,
        deletions,
        fromOid,
        toOid
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read that file at those revisions.')
      }
    }
  }




  /**
   * Per-line blame for the working file, used by the editor's inline annotation.
   *
   * `--line-porcelain` is deterministic and complete per line, so no state is
   * carried between lines. Uncommitted lines are reported as such instead of
   * being attributed to the previous commit. The result is capped so a huge
   * file cannot dominate the renderer.
   */
export async function blame(ctx: GitWorkspaceContext, sessionId: string, path: string): Promise<GitOutcome<{ lines: BlameLine[]; truncated: boolean }>> {
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').includes('..')
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That path is not valid for this worktree.'
      }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { raw, worktreePath } = resolved
    let result
    try {
      result = await raw(worktreePath, ['blame', '--line-porcelain', '--', path])
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read blame for that file.')
      }
    }
    if (result.exitCode !== 0) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git could not read blame for that file. It may be untracked or binary.'
      }
    }
    const all = parseBlamePorcelain(result.stdout)
    const limit = 50_000
    return {
      status: 'ok',
      lines: all.slice(0, limit),
      truncated: all.length > limit
    }
  }




  /**
   * Reads one file at a revision, with worktree filters applied.
   *
   * The Files editor uses this as its quick-diff baseline. The size check runs
   * before content is requested so a huge blob cannot enter the renderer, and a
   * NUL byte marks a binary blob instead of pretending it is editable text.
   */
export async function fileAtRevision(ctx: GitWorkspaceContext, sessionId: string, rev: string, path: string): Promise<
    GitOutcome<{
      rev: string
      oid: string
      text: string
      binary: boolean
      tooLarge: boolean
    }>
  > {
    const revision = rev.trim()
    if (
      revision.length === 0 ||
      revision.startsWith('-') ||
      revision.includes('\u0000') ||
      revision.includes('\n')
    ) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That revision is not valid.' }
    }
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').includes('..')
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That path is not valid for this worktree.'
      }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    const oid = await git(worktreePath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${revision}^{commit}`
    ]).catch(() => null)
    if (oid === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That revision is not available in this worktree.'
      }
    }
    const spec = `${oid}:${path}`
    const sizeText = await git(worktreePath, ['cat-file', '-s', spec]).catch(() => null)
    if (sizeText === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That file is not present at the requested revision.'
      }
    }
    const size = Number.parseInt(sizeText.trim(), 10)
    if (!Number.isFinite(size)) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git did not report a size for that file.'
      }
    }
    if (size > FILES_MAX_FILE_BYTES) {
      return { status: 'ok', rev: revision, oid, text: '', binary: false, tooLarge: true }
    }
    try {
      // `raw` preserves the exact blob text, including a trailing newline; the
      // trimmed `git` helper would corrupt the quick-diff baseline.
      const content = await raw(worktreePath, [
        'cat-file',
        '--filters',
        `--path=${path}`,
        spec
      ])
      if (content.exitCode !== 0) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: 'Git could not read that file at the revision.'
        }
      }
      const text = content.stdout
      const binary = text.includes('\u0000')
      return {
        status: 'ok',
        rev: revision,
        oid,
        text: binary ? '' : text,
        binary,
        tooLarge: false
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read that file at the revision.')
      }
    }
  }




  /**
   * Reads one file from the index (stage 0).
   *
   * The working-tree split diff needs both sides as complete text, not just the
   * patch. The index side is the middle term of a staged diff (HEAD→index) and
   * the pre-image of an unstaged diff (index→worktree). An unmerged path has no
   * stage 0, so it is reported as unavailable rather than silently reading a
   * conflict stage.
   */
export async function indexFile(ctx: GitWorkspaceContext, sessionId: string, path: string): Promise<
    GitOutcome<{
      path: string
      text: string
      binary: boolean
      tooLarge: boolean
    }>
  > {
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').includes('..')
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That path is not valid for this worktree.'
      }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    let listing
    try {
      listing = await raw(worktreePath, ['ls-files', '--stage', '-z', '--', path])
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read the index for that file.')
      }
    }
    if (listing.exitCode !== 0) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git could not read the index for that file.'
      }
    }
    const record = listing.stdout.split('\u0000').find((entry: string) => entry.length > 0)
    if (record === undefined) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That file is not in the index.'
      }
    }
    const tab = record.indexOf('\t')
    const meta = (tab === -1 ? record : record.slice(0, tab)).split(' ')
    const oid = meta[1] ?? ''
    const stage = meta[2] ?? ''
    if (!/^[0-9a-f]{40,64}$/u.test(oid)) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git did not report a blob for that file.'
      }
    }
    if (stage !== '0') {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That file has unresolved conflict stages in the index.'
      }
    }
    const sizeText = await git(worktreePath, ['cat-file', '-s', oid]).catch(() => null)
    if (sizeText === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git could not read that file from the index.'
      }
    }
    const size = Number.parseInt(sizeText.trim(), 10)
    if (!Number.isFinite(size)) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git did not report a size for that file.'
      }
    }
    if (size > FILES_MAX_FILE_BYTES) {
      return { status: 'ok', path, text: '', binary: false, tooLarge: true }
    }
    try {
      const content = await raw(worktreePath, ['cat-file', '--filters', `--path=${path}`, oid])
      if (content.exitCode !== 0) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: 'Git could not read that file from the index.'
        }
      }
      const binary = content.stdout.includes('\u0000')
      return {
        status: 'ok',
        path,
        text: binary ? '' : content.stdout,
        binary,
        tooLarge: false
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read that file from the index.')
      }
    }
  }
