import type { GitWorkspaceContext } from '../workspace-context'
import type { GitOutcome } from '../git-workspace-service'
import type { GitCommitResult } from '../../../shared/domain/git-workspace'
import {
  MAX_MESSAGE_LENGTH,
  STATUS_ARGS,
  detailOf,
  entriesOf,
  validateSingleFilePatch
} from '../git-helpers'
import {
  executeDiscardBatch,
  executePathBatch,
  type GitBatchResult,
  type GitPathTarget
} from '../batch-ops'
import { parsePorcelainV2 } from '../status-reader'
import { FILES_MAX_FILE_BYTES } from '../../../shared/domain/workspace-files'



  /**
   * Commits the index as it stands, or every tracked change with `all`.
   *
   * The message is passed as argv, never through a shell, and an empty index is
   * refused before Git runs so the user gets a sentence rather than Git's
   * "nothing to commit" exit status.
   */
export async function commit(ctx: GitWorkspaceContext, sessionId: string, message: string, options: { all?: boolean; signOff?: boolean; sign?: boolean } = {}): Promise<GitOutcome<GitCommitResult>> {
    const trimmed = message.trim()
    if (trimmed.length === 0) {
      return { status: 'unavailable', reason: 'commit-failed', detail: 'A commit message is required.' }
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      return {
        status: 'unavailable',
        reason: 'commit-failed',
        detail: `The commit message is longer than ${String(MAX_MESSAGE_LENGTH)} characters.`
      }
    }

    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved

    const stagedCount = await git(worktreePath, ['diff', '--cached', '--name-only'])
      .then((value) => value.split('\n').filter((line) => line.trim().length > 0).length)
      .catch(() => 0)
    // `git commit -a` also picks up tracked working-tree changes, so a staged
    // index is not required for it.
    const trackedUnstagedCount =
      options.all === true
        ? await git(worktreePath, ['diff', '--name-only'])
            .then((value) => value.split('\n').filter((line) => line.trim().length > 0).length)
            .catch(() => 0)
        : 0
    if (stagedCount === 0 && trackedUnstagedCount === 0) {
      return {
        status: 'unavailable',
        reason: 'nothing-to-commit',
        detail: 'There is nothing staged to commit. Stage the changes you want first.'
      }
    }

    const args = ['commit']
    if (options.all === true) args.push('-a')
    if (options.signOff === true) args.push('--signoff')
    if (options.sign === true) args.push('-S')
    args.push('-m', trimmed)

    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, args)
      })
    } catch (error) {
      return { status: 'unavailable', reason: 'commit-failed', detail: detailOf(error, 'Git refused the commit.') }
    }

    const oid = await git(worktreePath, ['rev-parse', 'HEAD']).catch(() => '')
    const subject = await git(worktreePath, ['log', '-1', '--pretty=%s']).catch(() => trimmed)
    return {
      status: 'ok',
      oid: oid.slice(0, 7),
      subject,
      files: stagedCount
    }
  }




  /**
   * Stages or unstages a selection in one serialized operation.
   *
   * Each target keeps its own outcome, so a path the live Agent changed between
   * the snapshot and the command is reported as failed rather than failing the
   * whole batch. `unborn` selects `git rm --cached` for unstage, because there is
   * no HEAD to reset to.
   */
export async function setPathsStaged(ctx: GitWorkspaceContext, sessionId: string, targets: readonly GitPathTarget[], staged: boolean): Promise<GitOutcome<{ result: GitBatchResult }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    const before = await ctx.readStatus(raw, worktreePath)
    if (before === null) {
      return { status: 'unavailable', reason: 'worktree-unavailable', detail: 'Git could not read this worktree.' }
    }
    const result = await ctx.queue.runExclusive(worktreePath, () =>
      executePathBatch({
        action: staged ? 'stage' : 'unstage',
        targets,
        unborn: before.headOid === null,
        execute: async (args) => {
          await git(worktreePath, [...args])
        }
      })
    )
    return { status: 'ok', result }
  }




  /**
   * Discards a selection after checking that it still describes the worktree.
   *
   * `expectedRevision` is the status stamp from the snapshot the user saw. A
   * mismatch means the live Agent edited the checkout in between, and a
   * destructive command must not proceed on the old assumption.
   */
export async function discardPaths(ctx: GitWorkspaceContext, sessionId: string, targets: readonly GitPathTarget[], expectedRevision?: string): Promise<GitOutcome<{ result: GitBatchResult }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    const before = await ctx.readStatus(raw, worktreePath)
    if (before === null) {
      return { status: 'unavailable', reason: 'worktree-unavailable', detail: 'Git could not read this worktree.' }
    }
    if (expectedRevision !== undefined && before.revision !== expectedRevision) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'The worktree changed since this selection was read. Refresh and select the paths again.'
      }
    }
    const result = await ctx.queue.runExclusive(worktreePath, () =>
      executeDiscardBatch({
        targets,
        execute: async (commands) => {
          for (const args of commands) await git(worktreePath, [...args])
        }
      })
    )
    return { status: 'ok', result }
  }




  /** Stages or unstages one path, leaving every other path as it was. */
export async function setPathStaged(ctx: GitWorkspaceContext, sessionId: string, path: string, staged: boolean): Promise<GitOutcome<{ path: string; staged: boolean }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    const relative = path
    if (
      relative.length === 0 ||
      relative.startsWith('/') ||
      relative.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      return { status: 'unavailable', reason: 'path-outside', detail: 'That path is not inside this worktree.' }
    }

    return ctx.queue.runExclusive(worktreePath, async () => {
      const statusRead = await raw(worktreePath, STATUS_ARGS)
      if (statusRead.exitCode !== 0) {
        return {
          status: 'unavailable' as const,
          reason: 'not-a-repository' as const,
          detail: 'Git could not read this worktree as a repository.'
        }
      }
      const entries = entriesOf(parsePorcelainV2(statusRead.stdout)).filter(
        (candidate) => candidate.path === relative
      )
      const entry = entries.find((candidate) =>
        staged ? candidate.area === 'unstaged' || candidate.area === 'untracked' : candidate.area === 'staged'
      )
      if (!entry) {
        return {
          status: 'unavailable' as const,
          reason: 'not-found' as const,
          detail: 'Git does not report that path as changed in that area.'
        }
      }
      if (entries.some((candidate) => candidate.area === 'conflicted')) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: 'That path has a conflict. Resolve it in the terminal before staging it here.'
        }
      }

      try {
        await git(worktreePath, staged ? ['add', '--', relative] : ['reset', '--', relative])
        return { status: 'ok' as const, path: relative, staged }
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: detailOf(error, `Git could not ${staged ? 'stage' : 'unstage'} that path.`)
        }
      }
    })
  }




  /**
   * Rewrites the last commit's message. This is deliberately local; no
   * force-push is offered here, because a rewritten commit is not safe to send
   * to a shared branch without a separate decision.
   */
export async function amend(ctx: GitWorkspaceContext, sessionId: string, message?: string, options: { sign?: boolean } = {}): Promise<GitOutcome<GitCommitResult>> {
    const trimmed = (message ?? '').trim()
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      return {
        status: 'unavailable',
        reason: 'commit-failed',
        detail: `The commit message is longer than ${String(MAX_MESSAGE_LENGTH)} characters.`
      }
    }

    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const head = await git(worktreePath, ['rev-parse', '--verify', 'HEAD']).catch(() => null)
    if (head === null) {
      return {
        status: 'unavailable',
        reason: 'commit-failed',
        detail: 'This worktree has no commit to amend yet.'
      }
    }
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, [
          'commit',
          '--amend',
          ...(options.sign === true ? ['-S'] : []),
          ...(trimmed.length > 0 ? ['-m', trimmed] : ['--no-edit'])
        ])
      })
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'commit-failed',
        detail: detailOf(error, 'Git refused to amend the last commit.')
      }
    }
    const oid = await git(worktreePath, ['rev-parse', 'HEAD']).catch(() => '')
    const subject = await git(worktreePath, ['log', '-1', '--pretty=%s']).catch(() => trimmed)
    return { status: 'ok', oid: oid.slice(0, 7), subject, files: 0 }
  }




  /**
   * Reads the three index stages of one conflicted path.
   *
   * Stage 1 is the merge base, 2 is current/ours and 3 is incoming/theirs. Base
   * is absent for add/add conflicts. Binary and oversized sides are reported as
   * flags so the renderer falls back to the terminal instead of showing mojibake.
   */
export async function conflictFile(ctx: GitWorkspaceContext, sessionId: string, path: string): Promise<
    GitOutcome<{
      path: string
      base: { oid: string; text: string; binary: boolean; tooLarge: boolean } | null
      current: { oid: string; text: string; binary: boolean; tooLarge: boolean }
      incoming: { oid: string; text: string; binary: boolean; tooLarge: boolean }
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
        detail: detailOf(error, 'Git could not read the index for that conflict.')
      }
    }
    if (listing.exitCode !== 0) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git could not read the index for that conflict.'
      }
    }
    const stages = new Map<number, string>()
    for (const record of listing.stdout.split('\u0000')) {
      if (record.length === 0) continue
      const tab = record.indexOf('\t')
      const meta = (tab === -1 ? record : record.slice(0, tab)).split(' ')
      const oid = meta[1] ?? ''
      const stage = Number.parseInt(meta[2] ?? '', 10)
      if (/^[0-9a-f]{40,64}$/u.test(oid) && Number.isFinite(stage) && stage >= 1 && stage <= 3) {
        stages.set(stage, oid)
      }
    }
    if (!stages.has(2) || !stages.has(3)) {
      return {
        status: 'unavailable',
        reason: 'not-found',
        detail: 'That path does not have both conflict sides in the index.'
      }
    }

    const readSide = async (
      oid: string
    ): Promise<
      | { ok: true; side: { oid: string; text: string; binary: boolean; tooLarge: boolean } }
      | { ok: false; detail: string }
    > => {
      const sizeText = await git(worktreePath, ['cat-file', '-s', oid]).catch(() => null)
      const size = sizeText === null ? Number.NaN : Number.parseInt(sizeText.trim(), 10)
      if (!Number.isFinite(size)) return { ok: false, detail: 'Git did not report a conflict side.' }
      if (size > FILES_MAX_FILE_BYTES) {
        return { ok: true, side: { oid, text: '', binary: false, tooLarge: true } }
      }
      try {
        const content = await raw(worktreePath, ['cat-file', '--filters', `--path=${path}`, oid])
        if (content.exitCode !== 0) {
          return { ok: false, detail: 'Git could not read a side of that conflict.' }
        }
        const binary = content.stdout.includes('\u0000')
        return {
          ok: true,
          side: { oid, text: binary ? '' : content.stdout, binary, tooLarge: false }
        }
      } catch (error) {
        return { ok: false, detail: detailOf(error, 'Git could not read a side of that conflict.') }
      }
    }

    const current = await readSide(stages.get(2)!)
    if (!current.ok) {
      return { status: 'unavailable', reason: 'git-failed', detail: current.detail }
    }
    const incoming = await readSide(stages.get(3)!)
    if (!incoming.ok) {
      return { status: 'unavailable', reason: 'git-failed', detail: incoming.detail }
    }
    const baseOid = stages.get(1)
    let base = null
    if (baseOid !== undefined) {
      const read = await readSide(baseOid)
      if (!read.ok) {
        return { status: 'unavailable', reason: 'git-failed', detail: read.detail }
      }
      base = read.side
    }
    return { status: 'ok', path, base, current: current.side, incoming: incoming.side }
  }




  /**
   * Marks a conflicted path resolved by adding its worktree result to the index.
   *
   * This is separate from `setPathStaged`, which deliberately refuses conflicted
   * paths; the merge editor calls it only after all markers are gone.
   */
export async function resolveConflict(ctx: GitWorkspaceContext, sessionId: string, path: string): Promise<GitOutcome<{ path: string }>> {
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      return {
        status: 'unavailable',
        reason: 'path-outside',
        detail: 'That path is not inside this worktree.'
      }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    return ctx.queue.runExclusive(worktreePath, async () => {
      const statusRead = await raw(worktreePath, STATUS_ARGS)
      if (statusRead.exitCode !== 0) {
        return {
          status: 'unavailable' as const,
          reason: 'not-a-repository' as const,
          detail: 'Git could not read this worktree as a repository.'
        }
      }
      const entry = entriesOf(parsePorcelainV2(statusRead.stdout)).find(
        (candidate) => candidate.path === path && candidate.area === 'conflicted'
      )
      if (entry === undefined) {
        return {
          status: 'unavailable' as const,
          reason: 'not-found' as const,
          detail: 'Git does not report that path as conflicted.'
        }
      }
      try {
        await git(worktreePath, ['add', '--', path])
        return { status: 'ok' as const, path }
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: detailOf(error, 'Git could not mark that conflict resolved.')
        }
      }
    })
  }




  /**
   * Stages or unstages one hunk by applying its patch to the index.
   *
   * The patch comes from the same `git diff` the renderer displayed. `git apply`
   * checks the hunk's context against the index before writing, so a stale
   * patch is rejected rather than applied to a different revision. Only one
   * plain file patch is accepted: renames, copies, binary/submodule patches and
   * mode changes stay with the whole-file actions.
   */
export async function applyPatch(ctx: GitWorkspaceContext, sessionId: string, patch: string, path: string, mode: 'stage' | 'unstage' | 'discard'): Promise<GitOutcome<{ path: string; mode: 'stage' | 'unstage' | 'discard' }>> {
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      return {
        status: 'unavailable',
        reason: 'path-outside',
        detail: 'That path is not inside this worktree.'
      }
    }
    // `git apply` rejects a final hunk line without a newline. The renderer
    // slices hunks out of a larger patch, so the last line may arrive bare.
    const inputPatch = patch.endsWith('\n') ? patch : `${patch}\n`
    const invalid = validateSingleFilePatch(inputPatch, path)
    if (invalid !== null) {
      return { status: 'unavailable', reason: 'git-failed', detail: invalid }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { input, raw, worktreePath } = resolved
    return ctx.queue.runExclusive(worktreePath, async () => {
      const statusRead = await raw(worktreePath, STATUS_ARGS)
      if (statusRead.exitCode !== 0) {
        return {
          status: 'unavailable' as const,
          reason: 'not-a-repository' as const,
          detail: 'Git could not read this worktree as a repository.'
        }
      }
      const entries = entriesOf(parsePorcelainV2(statusRead.stdout)).filter(
        (candidate) => candidate.path === path
      )
      if (entries.some((candidate) => candidate.area === 'conflicted')) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: 'That path has a conflict. Resolve it before staging a hunk here.'
        }
      }
      if (mode === 'discard') {
        if (entries.some((candidate) => candidate.area === 'untracked')) {
          return {
            status: 'unavailable' as const,
            reason: 'git-failed' as const,
            detail: 'Untracked files are not discarded by hunk; delete the file instead.'
          }
        }
        if (!entries.some((candidate) => candidate.area === 'unstaged')) {
          return {
            status: 'unavailable' as const,
            reason: 'not-found' as const,
            detail: 'Git does not report that path as unstaged.'
          }
        }
      } else {
        const expectedArea = mode === 'stage' ? ['unstaged', 'untracked'] : ['staged']
        if (!entries.some((candidate) => expectedArea.includes(candidate.area))) {
          return {
            status: 'unavailable' as const,
            reason: 'not-found' as const,
            detail: `Git does not report that path as ${mode === 'stage' ? 'unstaged' : 'staged'}.`
          }
        }
      }
      const args = [
        'apply',
        ...(mode === 'discard' ? [] : ['--cached']),
        ...(mode === 'stage' ? [] : ['--reverse']),
        '--recount',
        '--whitespace=nowarn',
        `--include=${path}`,
        '-'
      ]
      const result = await input(worktreePath, args, inputPatch)
      if (result.timedOut) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: 'Git timed out while applying that hunk.'
        }
      }
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim().slice(0, 800)
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail:
            detail.length > 0
              ? `Git rejected that hunk: ${detail}`
              : 'Git rejected that hunk.'
        }
      }
      return { status: 'ok' as const, path, mode }
    })
  }
