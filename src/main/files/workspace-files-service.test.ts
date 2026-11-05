import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalFileBackend, FileAccessError } from './local-file-backend'
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
  trashStateFile?: string
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
    ...(options.trashStateFile === undefined
      ? {}
      : { trashStateFile: options.trashStateFile }),
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

  it('returns an opaque version and refuses a stale write without touching the file', async () => {
    const root = home()
    writeFileSync(join(root, 'README.md'), 'hello\n')
    const backend = createLocalFileBackend(root)

    const read = await backend.read('README.md')
    expect(read.etag).toBeTruthy()
    expect(await backend.stat('README.md')).toMatchObject({
      kind: 'file',
      etag: read.etag
    })

    // The Agent writes after the user read the file.
    writeFileSync(join(root, 'README.md'), 'agent version\n')

    await expect(backend.write('README.md', 'mine\n', read.etag)).rejects.toMatchObject({
      reason: 'changed-on-disk'
    })
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('agent version\n')
  })

  it('saves with the current version and returns the next one', async () => {
    const root = home()
    writeFileSync(join(root, 'a.ts'), 'one\n')
    const backend = createLocalFileBackend(root)
    const read = await backend.read('a.ts')
    const written = await backend.write('a.ts', 'two\n', read.etag)
    expect(written.size).toBe(4)
    expect(written.etag).not.toBe(read.etag)
    expect((await backend.stat('a.ts')).etag).toBe(written.etag)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('two\n')
  })

  it('treats a null version as "must not exist yet"', async () => {
    const root = home()
    const backend = createLocalFileBackend(root)
    expect(await backend.write('new.ts', 'one\n', null)).toMatchObject({ size: 4 })
    await expect(backend.write('new.ts', 'two\n', null)).rejects.toMatchObject({
      reason: 'changed-on-disk'
    })
    expect(readFileSync(join(root, 'new.ts'), 'utf8')).toBe('one\n')
  })

  it('returns the created file version', async () => {
    const root = home()
    const backend = createLocalFileBackend(root)
    const created = await backend.create('new.ts', 'file')
    expect(created.etag).toBeTruthy()
    expect((await backend.stat('new.ts')).etag).toBe(created.etag)
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

    const result = await createLocalFileBackend(root).search('needle', {
      caseSensitive: true,
      wholeWord: false,
      regex: false,
      include: [],
      exclude: [],
      limit: 50
    })
    expect(result.matches.map((match) => `${match.path}:${match.line}`)).toEqual(['src/a.ts:1'])
    expect(result.matches[0]?.column).toBe(7)
  })

  it('applies case, whole-word, regex, include and exclude options', async () => {
    const root = home()
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'src', 'a.ts'), 'const cat = 1\nconcatenate cat\nCat\n')
    writeFileSync(join(root, 'docs', 'a.md'), 'cat\n')
    const backend = createLocalFileBackend(root)
    const base = {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      include: [],
      exclude: [],
      limit: 50
    }

    const all = await backend.search('cat', base)
    expect(all.matches.map((match) => match.path)).toEqual([
      'docs/a.md',
      'src/a.ts',
      'src/a.ts',
      'src/a.ts'
    ])

    const wholeWord = await backend.search('cat', {
      ...base,
      wholeWord: true,
      include: ['src/**']
    })
    expect(wholeWord.matches.map((match) => `${String(match.line)}:${String(match.column)}`)).toEqual([
      '1:7',
      '2:13',
      '3:1'
    ])

    const sensitive = await backend.search('Cat', {
      ...base,
      caseSensitive: true,
      include: ['src/**']
    })
    expect(sensitive.matches.map((match) => `${String(match.line)}:${String(match.column)}`)).toEqual([
      '3:1'
    ])

    const regex = await backend.search('c.t', {
      ...base,
      regex: true,
      include: ['src/**']
    })
    expect(regex.matches.map((match) => match.line)).toEqual([1, 2, 3])

    expect(
      await backend.search('cat', { ...base, include: ['src/**'], exclude: ['src/a.ts'] })
    ).toMatchObject({ matches: [] })
  })

  it('stops a cancelled scan instead of finishing it', async () => {
    const root = home()
    writeFileSync(join(root, 'a.ts'), 'needle\n')
    const controller = new AbortController()
    controller.abort()
    const result = await createLocalFileBackend(root).search('needle', {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      include: [],
      exclude: [],
      limit: 50,
      signal: controller.signal
    })
    expect(result).toMatchObject({ matches: [], scannedFiles: 0, cancelled: true })
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

describe('workspace files: copy and batch operations', () => {
  function sessionBacked(root: string) {
    return service({ target: LOCAL, worktreePath: root, backend: createLocalFileBackend(root) })
  }

  it('copies a file and a directory tree without overwriting', async () => {
    const root = home()
    writeFileSync(join(root, 'a.txt'), 'hello\n')
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'inner.txt'), 'inner\n')
    const backend = createLocalFileBackend(root)

    await backend.copy('a.txt', 'b.txt')
    await backend.copy('dir', 'dir2')
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('hello\n')
    expect(readFileSync(join(root, 'dir2', 'inner.txt'), 'utf8')).toBe('inner\n')

    await expect(backend.copy('a.txt', 'b.txt')).rejects.toMatchObject({
      reason: 'already-exists'
    })
    await expect(backend.copy('dir', 'dir/inner-dir')).rejects.toMatchObject({
      reason: 'write-failed'
    })
  })

  it('auto-names copies instead of overwriting', async () => {
    const root = home()
    writeFileSync(join(root, 'note.txt'), 'one\n')
    const svc = sessionBacked(root)

    const first = await svc.copyMany('ses_x', ['note.txt'], '')
    const second = await svc.copyMany('ses_x', ['note.txt'], '')
    const third = await svc.copyMany('ses_x', ['note.txt'], '')
    expect(first.status === 'ok' ? first.results[0]?.to : null).toBe('note copy.txt')
    expect(second.status === 'ok' ? second.results[0]?.to : null).toBe('note copy 2.txt')
    expect(third.status === 'ok' ? third.results[0]?.to : null).toBe('note copy 3.txt')
    expect(readFileSync(join(root, 'note copy 3.txt'), 'utf8')).toBe('one\n')
  })

  it('refuses the whole move batch when one target exists', async () => {
    const root = home()
    writeFileSync(join(root, 'a.txt'), 'a\n')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    mkdirSync(join(root, 'dest'))
    writeFileSync(join(root, 'dest', 'a.txt'), 'existing\n')
    const svc = sessionBacked(root)

    const result = await svc.moveMany('ses_x', ['a.txt', 'b.txt'], 'dest')
    expect(result).toMatchObject({ status: 'unavailable', reason: 'already-exists' })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b\n')
    expect(readFileSync(join(root, 'dest', 'a.txt'), 'utf8')).toBe('existing\n')
    expect(() => readFileSync(join(root, 'dest', 'b.txt'))).toThrow()
  })

  it('moves several paths and skips same-parent items', async () => {
    const root = home()
    writeFileSync(join(root, 'a.txt'), 'a\n')
    mkdirSync(join(root, 'dest'))
    writeFileSync(join(root, 'dest', 'b.txt'), 'b\n')
    const svc = sessionBacked(root)

    const result = await svc.moveMany('ses_x', ['a.txt', 'dest/b.txt'], 'dest')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.results).toEqual([
        { path: 'a.txt', from: 'a.txt', to: 'dest/a.txt', ok: true },
        { path: 'dest/b.txt', from: 'dest/b.txt', to: 'dest/b.txt', ok: true, skipped: true }
      ])
    }
    expect(readFileSync(join(root, 'dest', 'a.txt'), 'utf8')).toBe('a\n')
  })

  it('refuses duplicate destination names and moving a folder into itself', async () => {
    const root = home()
    mkdirSync(join(root, 'one'))
    mkdirSync(join(root, 'two'))
    writeFileSync(join(root, 'one', 'x.txt'), '1\n')
    writeFileSync(join(root, 'two', 'x.txt'), '2\n')
    const svc = sessionBacked(root)

    expect(await svc.moveMany('ses_x', ['one/x.txt', 'two/x.txt'], '')).toMatchObject({
      status: 'unavailable',
      reason: 'already-exists'
    })
    expect(await svc.moveMany('ses_x', ['one'], 'one/inside')).toMatchObject({
      status: 'unavailable',
      reason: 'write-failed'
    })
    expect(await svc.copyMany('ses_x', ['one'], 'one/inside')).toMatchObject({
      status: 'unavailable',
      reason: 'write-failed'
    })
  })

  it('deletes a batch, collapses descendants and tolerates missing paths', async () => {
    const root = home()
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'a.txt'), 'a\n')
    writeFileSync(join(root, 'gone.txt'), 'gone\n')
    const svc = sessionBacked(root)

    const result = await svc.removeMany('ses_x', ['dir', 'dir/a.txt', 'already-gone.txt'])
    expect(result).toMatchObject({ status: 'ok' })
    if (result.status === 'ok') {
      expect(result.results.map((entry) => `${entry.path}:${String(entry.ok)}`)).toEqual([
        'dir:true',
        'already-gone.txt:true'
      ])
    }
    expect(() => readFileSync(join(root, 'dir'))).toThrow()
  })

  it('resolves relative and host-absolute clipboard paths', async () => {
    const root = home()
    writeFileSync(join(root, 'a.txt'), 'a\n')
    const svc = sessionBacked(root)
    expect(await svc.copyPaths('ses_x', ['a.txt', 'a.txt'], 'relative')).toMatchObject({
      status: 'ok',
      paths: ['a.txt']
    })
    const absolute = await svc.copyPaths('ses_x', ['a.txt'], 'absolute')
    expect(absolute).toMatchObject({ status: 'ok', paths: [join(root, 'a.txt')] })
  })
})

describe('workspace files: literal replace', () => {
  function sessionBacked(root: string) {
    return service({ target: LOCAL, worktreePath: root, backend: createLocalFileBackend(root) })
  }

  it('replaces literal matches and reports the counts', async () => {
    const root = home()
    writeFileSync(join(root, 'note.txt'), 'one needle twice needle\n')
    const svc = sessionBacked(root)

    const result = await svc.replace('ses_x', 'needle', 'pin', { caseSensitive: true })
    expect(result).toMatchObject({
      status: 'ok',
      files: 1,
      replacements: 2,
      truncated: false
    })
    if (result.status === 'ok') {
      expect(result.results).toEqual([{ path: 'note.txt', ok: true, replaced: 2 }])
    }
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('one pin twice pin\n')
  })

  it('skips a file whose version changed before the write', async () => {
    const root = home()
    writeFileSync(join(root, 'note.txt'), 'needle\n')
    const local = createLocalFileBackend(root)
    const changed = {
      ...local,
      write: async (): Promise<{ size: number; etag: string }> => {
        throw new FileAccessError('changed-on-disk', 'That file changed on disk.', 'sha256:other')
      }
    }
    const svc = service({ target: LOCAL, worktreePath: root, backend: changed })

    const result = await svc.replace('ses_x', 'needle', 'pin', { caseSensitive: true })
    expect(result).toMatchObject({ status: 'ok', files: 0, replacements: 0 })
    if (result.status === 'ok') {
      expect(result.results[0]).toMatchObject({
        path: 'note.txt',
        ok: false,
        replaced: 0,
        reason: 'changed-on-disk'
      })
    }
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('needle\n')
  })

  it('refuses regex replacement rather than guessing at a literal', async () => {
    const root = home()
    writeFileSync(join(root, 'note.txt'), 'needle\n')
    const svc = sessionBacked(root)
    expect(
      await svc.replace('ses_x', 'n.+e', 'pin', { regex: true })
    ).toMatchObject({ status: 'unavailable', reason: 'invalid-query' })
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('needle\n')
  })
})

describe('workspace files: app-managed trash', () => {
  function trashWorkspace() {
    const parent = mkdtempSync(join(tmpdir(), 'icode-trash-'))
    const root = join(parent, 'wt')
    mkdirSync(root)
    const state = join(parent, 'trash.json')
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }))
    const make = () =>
      service({
        target: LOCAL,
        worktreePath: root,
        backend: createLocalFileBackend(root),
        trashStateFile: state
      })
    return { parent, root, state, make }
  }

  it('moves files and folders out of the worktree and restores the batch', async () => {
    const { root, make } = trashWorkspace()
    writeFileSync(join(root, 'a.txt'), 'alpha\n')
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'inner.txt'), 'inner\n')
    const svc = make()

    const trashed = await svc.trashMany('ses_x', ['a.txt', 'dir'])
    expect(trashed).toMatchObject({ status: 'ok' })
    if (trashed.status !== 'ok') return
    expect(trashed.opId).toBeTruthy()
    expect(trashed.results.every((entry) => entry.ok)).toBe(true)
    expect(trashed.entries.map((entry) => entry.path)).toEqual(['dir', 'a.txt'])
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
    expect(existsSync(join(root, 'dir'))).toBe(false)

    const listed = await svc.listTrash('ses_x')
    expect(listed).toMatchObject({ status: 'ok' })
    if (listed.status === 'ok') {
      expect(listed.items[0]?.opId).toBe(trashed.opId)
      expect(listed.items[0]?.entries.map((entry) => entry.path)).toEqual(['dir', 'a.txt'])
    }

    const restored = await svc.restoreTrash('ses_x', trashed.opId!)
    expect(restored).toMatchObject({ status: 'ok' })
    if (restored.status === 'ok') {
      expect(restored.results.every((entry) => entry.ok)).toBe(true)
    }
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(readFileSync(join(root, 'dir', 'inner.txt'), 'utf8')).toBe('inner\n')
    const after = await svc.listTrash('ses_x')
    if (after.status === 'ok') expect(after.items).toEqual([])
  })

  it('refuses to overwrite a path recreated before restore', async () => {
    const { root, make } = trashWorkspace()
    writeFileSync(join(root, 'a.txt'), 'old\n')
    const svc = make()
    const trashed = await svc.trashMany('ses_x', ['a.txt'])
    expect(trashed.status).toBe('ok')
    if (trashed.status !== 'ok' || trashed.opId === null) return
    writeFileSync(join(root, 'a.txt'), 'new\n')

    const blocked = await svc.restoreTrash('ses_x', trashed.opId)
    expect(blocked).toMatchObject({ status: 'ok' })
    if (blocked.status === 'ok') {
      expect(blocked.results[0]).toMatchObject({
        path: 'a.txt',
        ok: false,
        reason: 'already-exists'
      })
    }
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new\n')
    const still = await svc.listTrash('ses_x')
    if (still.status === 'ok') expect(still.items).toHaveLength(1)

    rmSync(join(root, 'a.txt'))
    const restored = await svc.restoreTrash('ses_x', trashed.opId)
    expect(restored.status).toBe('ok')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('old\n')
  })

  it('keeps metadata across a service restart and rejects unknown batches', async () => {
    const { root, state, make } = trashWorkspace()
    writeFileSync(join(root, 'a.txt'), 'alpha\n')
    const first = make()
    const trashed = await first.trashMany('ses_x', ['a.txt'])
    expect(trashed.status).toBe('ok')
    if (trashed.status !== 'ok' || trashed.opId === null) return

    const second = service({
      target: LOCAL,
      worktreePath: root,
      backend: createLocalFileBackend(root),
      trashStateFile: state
    })
    const listed = await second.listTrash('ses_x')
    expect(listed.status).toBe('ok')
    if (listed.status === 'ok') expect(listed.items[0]?.opId).toBe(trashed.opId)
    expect(await second.restoreTrash('ses_x', 'op-does-not-exist')).toMatchObject({
      status: 'unavailable',
      reason: 'not-found'
    })
    expect(await second.restoreTrash('ses_x', trashed.opId)).toMatchObject({ status: 'ok' })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
  })

  it('reports a failed host move without leaving a restorable batch', async () => {
    const { root } = trashWorkspace()
    writeFileSync(join(root, 'a.txt'), 'alpha\n')
    const local = createLocalFileBackend(root)
    const failing = {
      ...local,
      trash: async (): Promise<void> => {
        throw new FileAccessError('write-failed', 'blocked')
      }
    }
    const svc = service({
      target: LOCAL,
      worktreePath: root,
      backend: failing,
      trashStateFile: join(root, '..', 'trash.json')
    })
    const result = await svc.trashMany('ses_x', ['a.txt'])
    expect(result).toMatchObject({ status: 'ok', opId: null })
    if (result.status === 'ok') {
      expect(result.results[0]).toMatchObject({ path: 'a.txt', ok: false, reason: 'write-failed' })
    }
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(await svc.listTrash('ses_x')).toMatchObject({ status: 'ok', items: [] })
  })

  it('purges batches older than seven days', async () => {
    const { parent, root, state, make } = trashWorkspace()
    const opId = 'op-old'
    const opDir = join(parent, '.icode-files-trash', 'ses_x', opId)
    mkdirSync(opDir, { recursive: true })
    writeFileSync(join(opDir, 'item-0'), 'old\n')
    writeFileSync(
      state,
      JSON.stringify({
        version: 1,
        sessions: {
          ses_x: [
            {
              opId,
              createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
              entries: [{ path: 'old.txt', name: 'item-0', kind: 'file' }]
            }
          ]
        }
      })
    )
    const svc = make()
    await svc.purgeTrash('ses_x')
    expect(existsSync(opDir)).toBe(false)
    const listed = await svc.listTrash('ses_x')
    if (listed.status === 'ok') expect(listed.items).toEqual([])
    expect(existsSync(root)).toBe(true)
  })
})
