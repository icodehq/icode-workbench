import { describe, expect, it, vi } from 'vitest'
import type { GitWorkspaceContext } from '../workspace-context'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import type {
  GuestGitScriptRequest,
  GuestGitScriptRunner
} from '../../wsl/git/guest-git-script'
import { readStatusSnapshot } from './status'

const WSL: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
}

const record = (...parts: string[]): string => `${parts.join(' ')}\u0000`

function statusOutput(): string {
  return (
    record('# branch.oid', 'a'.repeat(40)) +
    record('# branch.head', 'main') +
    record('1', 'MM', 'N...', '100644', '100644', '100644', 'hH', 'hI', 'src/a.ts')
  )
}

function frame(token: string, sections: Array<[string, number, string]>): string {
  return sections
    .map(([name, code, body]) => `\u0000@@${token}:${name}:${String(code)}\u0000${body}`)
    .join('')
}

function context(options: {
  target?: ExecutionTarget
  scriptFor?: () => Promise<GuestGitScriptRunner | null>
  raw?: (cwd: string, args: string[]) => Promise<{ stdout: string; exitCode: number | null }>
}) {
  const target = options.target ?? WSL
  const rawCalls: string[][] = []
  const raw =
    options.raw ??
    (async (_cwd: string, args: string[]) => {
      rawCalls.push(args)
      throw new Error('the per-call Git path must not run when a guest script exists')
    })
  const ctx = {
    resolve: async () => ({
      status: 'ok',
      worktreePath: target.kind === 'wsl' ? '/wt' : '/repo',
      repositoryPath: '/repo',
      repoId: 'repo_x',
      target,
      scope: 'worktree',
      git: async () => '',
      raw,
      input: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
    }),
    deps: {
      gitWorktrees: {
        streamGitFor: async () => null,
        scriptFor: options.scriptFor ?? (async () => null)
      }
    }
  } as unknown as GitWorkspaceContext
  return { ctx, rawCalls }
}

describe('status: batched guest read', () => {
  it('reads status and both numstat projections in one guest script', async () => {
    const requests: GuestGitScriptRequest[] = []
    const script: GuestGitScriptRunner = async (request) => {
      requests.push(request)
      const token = request.args[1]!
      return {
        status: 'ok',
        stdout: frame(token, [
          ['status', 0, statusOutput()],
          ['staged', 0, '2\t1\tsrc/a.ts\u0000'],
          ['unstaged', 0, '3\t0\tsrc/a.ts\u0000']
        ]),
        stderr: '',
        code: 0
      }
    }
    const { ctx, rawCalls } = context({ scriptFor: async () => script })

    const result = await readStatusSnapshot(ctx, 'ses_x', new AbortController().signal)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.snapshot.branch).toBe('main')
      expect(result.snapshot.headOid).toBe('a'.repeat(40))
      expect(result.snapshot.staged[0]).toMatchObject({
        path: 'src/a.ts',
        added: 2,
        removed: 1
      })
      expect(result.snapshot.unstaged[0]).toMatchObject({
        path: 'src/a.ts',
        added: 3,
        removed: 0
      })
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]?.args[0]).toBe('/wt')
    expect(rawCalls).toHaveLength(0)
  })

  it('reports a failed status read as not-a-repository', async () => {
    const script: GuestGitScriptRunner = async (request) => ({
      status: 'ok',
      stdout: frame(request.args[1]!, [
        ['status', 128, ''],
        ['staged', 0, ''],
        ['unstaged', 0, '']
      ]),
      stderr: '',
      code: 0
    })
    const { ctx } = context({ scriptFor: async () => script })
    await expect(
      readStatusSnapshot(ctx, 'ses_x', new AbortController().signal)
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'not-a-repository' })
  })

  it('surfaces a transport failure instead of inventing an empty status', async () => {
    const script: GuestGitScriptRunner = async () => ({
      status: 'transport',
      detail: 'The WSL distro did not answer the Git script.',
      timedOut: true
    })
    const { ctx } = context({ scriptFor: async () => script })
    await expect(
      readStatusSnapshot(ctx, 'ses_x', new AbortController().signal)
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'worktree-unavailable',
      detail: 'The WSL distro did not answer the Git script.'
    })
  })

  it('falls back to the per-call path when no guest script exists', async () => {
    const rawCalls: string[][] = []
    const { ctx } = context({
      scriptFor: async () => null,
      raw: async (_cwd, args) => {
        rawCalls.push(args)
        if (args[0] === 'status') return { stdout: statusOutput(), exitCode: 0 }
        if (args.includes('--cached')) {
          return { stdout: '1\t0\tsrc/a.ts\u0000', exitCode: 0 }
        }
        return { stdout: '0\t1\tsrc/a.ts\u0000', exitCode: 0 }
      }
    })

    const result = await readStatusSnapshot(ctx, 'ses_x', new AbortController().signal)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.snapshot.staged[0]).toMatchObject({ added: 1, removed: 0 })
      expect(result.snapshot.unstaged[0]).toMatchObject({ added: 0, removed: 1 })
    }
    expect(rawCalls.map((args) => args.join(' '))).toEqual([
      'status --porcelain=v2 --branch -z --untracked-files=all',
      'diff --cached --numstat -z -M',
      'diff --numstat -z -M'
    ])
  })

  it('does not start the batched path for a local checkout', async () => {
    const scriptFor = vi.fn(async () => null)
    const { ctx } = context({
      target: { kind: 'local' },
      scriptFor,
      raw: async (_cwd, args) => ({
        stdout: args[0] === 'status' ? statusOutput() : '',
        exitCode: 0
      })
    })
    // The local target keeps the stream/raw branches; the scriptFor call is
    // skipped entirely when the target is not WSL.
    const result = await readStatusSnapshot(ctx, 'ses_x', new AbortController().signal)
    expect(result.status).toBe('ok')
    expect(scriptFor).not.toHaveBeenCalled()
  })
})
