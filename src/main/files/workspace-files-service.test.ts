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
  const dir = mkdtempSync(join(tmpdir(), 'icode-files-'))
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
              branch: 'icode/x',
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

/**
 * File management inside the selected worktree.
 *
 * The dangerous outcomes are all of the same kind: creating over something that
 * exists, renaming across the worktree boundary, or deleting a path the user did
 * not select. Each is refused here rather than repaired later.
 */
describe('workspace files: management', () => {
  function sessionBacked(root: string) {
    return service({ target: LOCAL, worktreePath: root, backend: createLocalFileBackend(root) })
  }

  it('creates a file and a directory, and refuses to clobber either', async () => {
    const root = home()
    const svc = sessionBacked(root)

    expect(await svc.create('ses_x', 'new.ts', 'file')).toMatchObject({ status: 'ok', kind: 'file' })
    expect(readFileSync(join(root, 'new.ts'), 'utf8')).toBe('')
    expect(await svc.create('ses_x', 'docs', 'directory')).toMatchObject({ status: 'ok', kind: 'directory' })
    expect(await svc.create('ses_x', 'new.ts', 'file')).toMatchObject({
      status: 'unavailable',
      reason: 'already-exists'
    })
    // An existing empty file must survive a failed recreate.
    writeFileSync(join(root, 'new.ts'), 'keep me\n')
    expect(await svc.create('ses_x', 'new.ts', 'file')).toMatchObject({ reason: 'already-exists' })
    expect(readFileSync(join(root, 'new.ts'), 'utf8')).toBe('keep me\n')
  })

  it('creates inside a nested directory, and reports a missing parent', async () => {
    const root = home()
    const svc = sessionBacked(root)
    expect(await svc.create('ses_x', 'a/b.ts', 'file')).toMatchObject({ reason: 'not-found' })
    await svc.create('ses_x', 'a', 'directory')
    expect(await svc.create('ses_x', 'a/b.ts', 'file')).toMatchObject({ status: 'ok' })
  })

  it('renames a file and refuses to rename onto an existing path', async () => {
    const root = home()
    writeFileSync(join(root, 'one.ts'), 'one\n')
    writeFileSync(join(root, 'two.ts'), 'two\n')
    const svc = sessionBacked(root)

    expect(await svc.rename('ses_x', 'one.ts', 'moved.ts')).toMatchObject({ status: 'ok' })
    expect(readFileSync(join(root, 'moved.ts'), 'utf8')).toBe('one\n')
    expect(() => readFileSync(join(root, 'one.ts'))).toThrow()

    expect(await svc.rename('ses_x', 'moved.ts', 'two.ts')).toMatchObject({ reason: 'already-exists' })
    // Both files keep their content after the refusal.
    expect(readFileSync(join(root, 'moved.ts'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(root, 'two.ts'), 'utf8')).toBe('two\n')
  })

  it('refuses a rename that would escape the worktree', async () => {
    const root = home()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    const svc = sessionBacked(root)
    expect(await svc.rename('ses_x', 'a.ts', '../outside.ts')).toMatchObject({ reason: 'path-outside' })
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('x\n')
  })

  it('deletes a file and a directory tree, and reports a missing path', async () => {
    const root = home()
    writeFileSync(join(root, 'gone.ts'), 'x\n')
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'inner.ts'), 'y\n')
    const svc = sessionBacked(root)

    expect(await svc.remove('ses_x', 'gone.ts')).toMatchObject({ status: 'ok' })
    expect(await svc.remove('ses_x', 'dir')).toMatchObject({ status: 'ok' })
    expect(() => readFileSync(join(root, 'dir', 'inner.ts'))).toThrow()
    expect(await svc.remove('ses_x', 'gone.ts')).toMatchObject({ reason: 'not-found' })
  })

  it('refuses to delete or create at the worktree root', async () => {
    const root = home()
    const svc = sessionBacked(root)
    expect(await svc.remove('ses_x', '')).toMatchObject({ reason: 'path-outside' })
    expect(await svc.create('ses_x', '', 'file')).toMatchObject({ reason: 'path-outside' })
    expect(await svc.remove('ses_x', '../escape')).toMatchObject({ reason: 'path-outside' })
  })

  it('does not manage files when the distro cannot be reached', async () => {
    const svc = service({ target: WSL, fsThrows: true })
    expect(await svc.create('ses_x', 'a.ts', 'file')).toMatchObject({
      status: 'unavailable',
      reason: 'worktree-unavailable'
    })
  })
})
