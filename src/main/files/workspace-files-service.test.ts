import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalFileBackend } from './local-file-backend'
import { WorkspaceFilesService, type WorkspaceFilesDeps } from './workspace-files-service'
import type { ExecutionTarget } from '../../shared/domain/repository'

/**
 * The file tools must answer about the checkout's own host.
 *
 * The dangerous mistakes are all in the same family: a guest path tested on the
 * controller, and "cannot tell" reported as "not there" — which sends a user to
 * recreate a project that is merely offline.
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ade-files-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const WSL: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
}
const LOCAL: ExecutionTarget = { kind: 'local' }

function service(options: {
  target?: ExecutionTarget
  /** null means "this session has no worktree record". */
  worktreePath?: string | null
  fsThrows?: boolean
  exists?: boolean
  backend?: ReturnType<typeof createLocalFileBackend>
} = {}) {
  const deps = {
    sessions: {} as never,
    repositories: {
      findById: () => ({ id: 'repo_x', path: '/repo', executionTarget: options.target ?? LOCAL })
    } as never,
    worktrees: {
      findBySession: () =>
        options.worktreePath === null
          ? null
          : {
              sessionId: 'ses_x',
              repoId: 'repo_x',
              path: options.worktreePath ?? '/wt',
              branch: 'ade/x',
              baseRef: 'main',
              baseOid: 'a'.repeat(40),
              state: 'ready',
              error: null,
              createdAt: 1,
              updatedAt: 1
            }
    } as never,
    gitWorktrees: {
      hostFsFor: async () => {
        if (options.fsThrows) throw new Error('the distro did not answer')
        return { isDirectory: async () => options.exists ?? true }
      }
    } as never,
    runner: {} as never,
    ...(options.backend ? { backendFor: () => options.backend! } : {})
  } satisfies WorkspaceFilesDeps
  return new WorkspaceFilesService(deps)
}

describe('workspace files: checkout resolution', () => {
  it('reports a session without a worktree as primary-checkout', async () => {
    const result = await service({ worktreePath: null }).list('ses_x', '')
    expect(result).toMatchObject({ status: 'unavailable', reason: 'primary-checkout' })
  })

  it('reports an unreachable distro as unavailable, never as missing (AC-07)', async () => {
    const result = await service({ target: WSL, fsThrows: true }).list('ses_x', '')
    expect(result).toMatchObject({ status: 'unavailable', reason: 'worktree-unavailable' })
    if (result.status === 'unavailable') {
      expect(result.reason).not.toBe('worktree-missing')
      expect(result.detail).toContain('could not be reached')
    }
  })

  it('reports a genuinely absent worktree as missing', async () => {
    const result = await service({ target: WSL, exists: false }).list('ses_x', '')
    expect(result).toMatchObject({ status: 'unavailable', reason: 'worktree-missing' })
    if (result.status === 'unavailable') expect(result.detail).toContain('inside its distro')
  })

  it('refuses a path that escapes the worktree before touching a host', async () => {
    for (const path of ['../etc', '/etc/passwd', 'a/../../b']) {
      const result = await service().read('ses_x', path)
      expect(result).toMatchObject({ status: 'unavailable', reason: 'path-outside' })
    }
  })
})

describe('workspace files: local backend', () => {
  it('lists directories first and reads and writes a file', async () => {
    const root = home()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'README.md'), 'hello\n')
    writeFileSync(join(root, 'src', 'a.ts'), 'const a = 1\n')

    const backend = createLocalFileBackend(root)
    const { entries } = await backend.list('')
    expect(entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      'directory:src',
      'file:README.md'
    ])

    const listing = await backend.list('src')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['a.ts'])

    const read = await backend.read('README.md')
    expect(read.text).toBe('hello\n')
    expect(read.binary).toBe(false)

    await backend.write('README.md', 'changed\n')
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('changed\n')
  })

  it('marks a binary file instead of returning mojibake', async () => {
    const root = home()
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x61, 0x00, 0x62]))
    const read = await createLocalFileBackend(root).read('blob.bin')
    expect(read.binary).toBe(true)
    expect(read.text).toBe('')
  })

  it('reports a missing file as not-found rather than an empty file', async () => {
    const root = home()
    await expect(createLocalFileBackend(root).read('nope.ts')).rejects.toMatchObject({ reason: 'not-found' })
  })

  it('searches text and skips dependency directories', async () => {
    const root = home()
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'src', 'a.ts'), 'const needle = 1\n')
    writeFileSync(join(root, 'node_modules', 'dep.js'), 'needle\n')

    const result = await createLocalFileBackend(root).search('needle', { caseSensitive: true, limit: 50 })
    expect(result.matches.map((match) => `${match.path}:${match.line}`)).toEqual(['src/a.ts:1'])
    expect(result.matches[0]?.column).toBe(7)
  })
})
