import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { resolveRepositoryRoot } from './repository-path'
import type { TempRoot } from '../persistence/persistence-test-fixtures'
import { newRepoId, newSessionId, newWorkspaceId } from '../../shared/domain/ids'
import type { Database } from '../persistence/database'
import { createTargetValidator } from '../wsl/repository-target'
import { WslCommandRunner, type WslProcessLauncher } from '../wsl/exec'

type Harness = {
  root: TempRoot
  db: Database
  service: ReturnType<typeof makeRepositoryService>['service']
  stores: ReturnType<typeof makeRepositoryService>
}

const active: Harness[] = []

function initGitRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', path], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', path, '-c', 'user.name=iCode Test', '-c', 'user.email=icode@example.test', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { stdio: 'pipe' }
  )
}

function harness(): Harness {
  const root = makeTempRoot('icode-repo-')
  const db = openTempDatabase(root)
  // WSL targets need a guest resolver. These tests exercise the target model, so
  // the stub answers with the same canonical root a guest would report for the
  // same path; guest path semantics are covered in the W6 suites.
  const stores = makeRepositoryService(db, {
    resolveRoot: async (path) => {
      const resolved = await resolveRepositoryRoot(path)
      return resolved
    }
  })
  const value = { root, db, service: stores.service, stores }
  active.push(value)
  return value
}

afterEach(() => {
  while (active.length > 0) {
    const item = active.pop()
    try {
      item?.db.close()
    } catch {
      // already closed
    }
    item?.root.cleanup()
  }
})

describe('repository registration', () => {
  it('registers a Git repository with its primary-checkout workspace', async () => {
    const h = harness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)
    const real = execFileSync('realpath', [repoPath]).toString().trim()

    const result = await h.service.addRepository(repoPath)
    expect(result.created).toBe(true)
    expect(result.repository.path).toBe(real)
    expect(result.repository.displayName).toBe('atlas')
    expect(result.repository.currentBranch).toBe('main')
    expect(result.repository.availability).toBe('present')

    const listed = h.service.listRepositories()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.workspace.repoId).toBe(result.repository.id)
    expect(listed[0]!.workspace.kind).toBe('primary-checkout')
    expect(listed[0]!.workspace.path).toBe(real)

    const detail = h.service.getRepository(result.repository.id)
    expect(detail?.workspace.id).toBe(listed[0]!.workspace.id)
  })

  it('registers a just-initialized folder without re-probing Git', async () => {
    const h = harness()
    const repoPath = join(h.root.dir, 'fresh')
    mkdirSync(repoPath, { recursive: true })
    const real = execFileSync('realpath', [repoPath]).toString().trim()

    const first = await h.service.addInitializedRepository(repoPath)
    expect(first.created).toBe(true)
    expect(first.repository.path).toBe(real)
    expect(first.repository.currentBranch).toBeNull()
    expect(first.repository.gitCommonDir).toBe(join(real, '.git'))
    expect(h.service.getRepository(first.repository.id)?.workspace.repoId).toBe(
      first.repository.id
    )

    const again = await h.service.addInitializedRepository(repoPath)
    expect(again.created).toBe(false)
    expect(again.repository.id).toBe(first.repository.id)
    expect(h.service.listRepositories()).toHaveLength(1)
  })

  it('treats the same path on another execution target as a distinct repository', async () => {
    const h = harness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)

    const local = await h.service.addRepository(repoPath)
    const onWsl = await h.service.addRepository(repoPath, {
      kind: 'wsl',
      distro: 'Ubuntu-A',
      distroId: 'guid-a'
    })
    expect(local.created).toBe(true)
    expect(onWsl.created).toBe(true)
    expect(onWsl.repository.id).not.toBe(local.repository.id)
    expect(onWsl.repository.executionTarget).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu-A',
      distroId: 'guid-a'
    })
    // The local row is untouched: still local, still the same canonical path.
    expect(h.service.getRepository(local.repository.id)?.repository.executionTarget).toEqual({
      kind: 'local'
    })
    expect(h.service.listRepositories()).toHaveLength(2)
  })

  it('deduplicates a renamed distro by registration id', async () => {
    const h = harness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)

    const first = await h.service.addRepository(repoPath, {
      kind: 'wsl',
      distro: 'Ubuntu-Old',
      distroId: 'guid-a'
    })
    const renamed = await h.service.addRepository(repoPath, {
      kind: 'wsl',
      distro: 'Ubuntu-Renamed',
      distroId: 'guid-a'
    })
    expect(renamed.created).toBe(false)
    expect(renamed.repository.id).toBe(first.repository.id)
    expect(h.service.listRepositories()).toHaveLength(1)
  })

  it('treats a duplicate canonical path as the existing repository', async () => {
    const h = harness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)
    const first = await h.service.addRepository(repoPath)
    const second = await h.service.addRepository(repoPath)
    const nested = join(repoPath, 'src')
    mkdirSync(nested)
    const third = await h.service.addRepository(nested)

    expect(second.created).toBe(false)
    expect(second.repository.id).toBe(first.repository.id)
    expect(third.created).toBe(false)
    expect(third.repository.id).toBe(first.repository.id)
    expect(h.service.listRepositories()).toHaveLength(1)
    expect(h.stores.repositories.workspaceForRepo(first.repository.id)).not.toBeNull()
  })

  it('deduplicates through a symlinked path', async () => {
    const h = harness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)
    const link = join(h.root.dir, 'atlas-link')
    symlinkSync(repoPath, link)
    const first = await h.service.addRepository(repoPath)
    const second = await h.service.addRepository(link)
    expect(second.repository.id).toBe(first.repository.id)
    expect(h.service.listRepositories()).toHaveLength(1)
  })

  it('rejects a missing path with PATH_NOT_FOUND', async () => {
    const h = harness()
    await expect(h.service.addRepository(join(h.root.dir, 'missing'))).rejects.toMatchObject({
      appError: { code: 'PATH_NOT_FOUND', retryable: false }
    })
    expect(h.service.listRepositories()).toHaveLength(0)
  })

  it('rejects a file with NOT_A_DIRECTORY', async () => {
    const h = harness()
    const file = join(h.root.dir, 'a-file')
    writeFileSync(file, 'x')
    await expect(h.service.addRepository(file)).rejects.toMatchObject({
      appError: { code: 'NOT_A_DIRECTORY' }
    })
  })

  it('rejects a non-Git directory with NOT_A_GIT_REPO and diagnostics', async () => {
    const h = harness()
    const plain = join(h.root.dir, 'plain')
    mkdirSync(plain)
    await expect(h.service.addRepository(plain)).rejects.toMatchObject({
      appError: { code: 'NOT_A_GIT_REPO', retryable: false }
    })
  })

  it('rejects an empty path', async () => {
    const h = harness()
    await expect(h.service.addRepository('   ')).rejects.toMatchObject({
      appError: { code: 'PATH_NOT_FOUND' }
    })
  })
})

describe('repository listing and availability', () => {
  it('marks a registered repository missing after its path disappears', async () => {
    const h = harness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)
    const added = await h.service.addRepository(repoPath)

    rmSync(repoPath, { recursive: true, force: true })
    const listed = h.service.listRepositories()
    expect(listed[0]!.repository.availability).toBe('missing')
    // The record and workspace survive so the UI can offer Locate/Remove.
    expect(listed[0]!.repository.id).toBe(added.repository.id)
    expect(listed[0]!.workspace.path).toBe(added.repository.path)

    const refreshed = h.service.refreshAvailability(added.repository.id)
    expect(refreshed?.availability).toBe('missing')
  })

  it('does not refresh paths when explicitly disabled', async () => {
    const h = harness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)
    const added = await h.service.addRepository(repoPath)
    rmSync(repoPath, { recursive: true, force: true })
    const listed = h.service.listRepositories({ refreshPaths: false })
    expect(listed[0]!.repository.availability).toBe('present')
    expect(added.repository.availability).toBe('present')
  })

  it('persists repositories across a close and reopen', async () => {
    const h = harness()
    const repoPath = join(h.root.dir, 'persisted')
    initGitRepo(repoPath)
    const added = await h.service.addRepository(repoPath)
    h.db.close()

    const reopened = openTempDatabase(h.root)
    const stores = makeRepositoryService(reopened)
    const listed = stores.service.listRepositories()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.repository.id).toBe(added.repository.id)
    expect(stores.service.getRepository(added.repository.id)?.workspace.path).toBe(
      added.repository.path
    )
    reopened.close()
  })

  it('returns null for unknown repository IDs', () => {
    const h = harness()
    expect(h.service.getRepository('repo_00000000-0000-4000-8000-000000000000')).toBeNull()
    expect(h.service.getRepository('not-an-id')).toBeNull()
  })
})

describe('schema invariants', () => {
  it('enforces canonical-path uniqueness at the database boundary', async () => {
    const h = harness()
    const one = await h.service.addRepository((() => {
      const path = join(h.root.dir, 'one')
      initGitRepo(path)
      return path
    })())
    expect(() =>
      h.stores.repositories.insert({ ...one.repository, id: newRepoId() })
    ).toThrow(/UNIQUE/i)
  })

  it('enforces exactly one primary-checkout workspace per repository', async () => {
    const h = harness()
    const path = join(h.root.dir, 'one')
    initGitRepo(path)
    const added = await h.service.addRepository(path)
    expect(() =>
      h.stores.repositories.insertWorkspace({
        id: newWorkspaceId(),
        repoId: added.repository.id,
        path: added.repository.path,
        kind: 'primary-checkout',
        createdAt: 2
      })
    ).toThrow(/UNIQUE/i)
  })

  it('rejects a session referencing an unknown workspace', async () => {
    const h = harness()
    expect(() =>
      h.stores.sessions.insert({
        id: newSessionId(),
        workspaceId: newWorkspaceId(),
        harness: 'claude',
        title: 'orphan',
        createdAt: 1,
        lastActiveAt: 1,
        observation: {
          lastObservedState: 'starting',
          lastObservedExitCode: null,
          lastObservedError: null,
          lastObservedIncarnationId: null,
          lastObservedAt: 1
        }
      })
    ).toThrow(/FOREIGN KEY/i)
  })
})

describe('repository deletion', () => {
  async function withSession(h: Harness): Promise<{ repoId: string; workspaceId: string }> {
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)
    const added = await h.service.addRepository(repoPath)
    const workspace = h.stores.repositories.workspaceForRepo(added.repository.id)
    if (!workspace) throw new Error('missing workspace')
    const sessionId = newSessionId()
    h.stores.sessions.insert({
      id: sessionId,
      workspaceId: workspace.id,
      harness: 'claude',
      title: 'Claude · atlas',
      createdAt: 10,
      lastActiveAt: 11,
      observation: {
        lastObservedState: 'live',
        lastObservedExitCode: null,
        lastObservedError: null,
        lastObservedIncarnationId: null,
        lastObservedAt: 11
      }
    })
    return { repoId: added.repository.id, workspaceId: workspace.id }
  }

  it('deletes a repository with no sessions and cascades its workspace', async () => {
    const h = harness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)
    const added = await h.service.addRepository(repoPath)
    const outcome = h.service.removeRepository(added.repository.id, {
      acknowledgeDependentSessions: false
    })
    expect(outcome.status).toBe('deleted')
    expect(h.service.listRepositories()).toHaveLength(0)
    expect(h.stores.repositories.workspaceForRepo(added.repository.id)).toBeNull()
  })

  it('requires acknowledgement before deleting stored sessions', async () => {
    const h = harness()
    const { repoId } = await withSession(h)
    const impact = h.service.describeDeletion(repoId)
    expect(impact?.sessions).toHaveLength(1)
    expect(impact?.sessions[0]!.lastObservedState).toBe('live')
    expect(impact?.requiresHostLivenessCheck).toBe(true)

    const blocked = h.service.removeRepository(repoId, { acknowledgeDependentSessions: false })
    expect(blocked.status).toBe('confirmation_required')
    expect(h.service.listRepositories()).toHaveLength(1)

    const done = h.service.removeRepository(repoId, { acknowledgeDependentSessions: true })
    expect(done).toMatchObject({ status: 'deleted', deletedSessions: 1 })
    expect(h.stores.sessions.listForRepo(repoId)).toHaveLength(0)
    expect(h.service.listRepositories()).toHaveLength(0)
  })

  it('reports not_found for an unknown or malformed repository ID', async () => {
    const h = harness()
    expect(
      h.service.removeRepository('repo_00000000-0000-4000-8000-000000000000', {
        acknowledgeDependentSessions: true
      }).status
    ).toBe('not_found')
    expect(() =>
      h.service.removeRepository('bad', { acknowledgeDependentSessions: true })
    ).toThrow(/Invalid repository ID/)
  })

  it('resolves a linked worktree to its primary repository instead of a duplicate', async () => {
    const h = harness()
    const primary = join(h.root.dir, 'primary')
    initGitRepo(primary)
    const added = await h.service.addRepository(primary)
    const linked = join(h.root.dir, 'primary-linked')
    execFileSync('git', ['-C', primary, 'worktree', 'add', '-q', '-b', 'feature', linked], {
      stdio: 'pipe'
    })

    const again = await h.service.addRepository(linked)
    expect(again.created).toBe(false)
    expect(again.repository.id).toBe(added.repository.id)
    expect(again.repository.path).toBe(added.repository.path)
    expect(again.registeredViaLinkedWorktree).toBeTruthy()
    expect(h.service.listRepositories()).toHaveLength(1)
  })

  it('deleting one repository leaves others intact', async () => {
    const h = harness()
    const firstPath = join(h.root.dir, 'first')
    const secondPath = join(h.root.dir, 'second')
    initGitRepo(firstPath)
    initGitRepo(secondPath)
    const first = await h.service.addRepository(firstPath)
    const second = await h.service.addRepository(secondPath)

    h.service.removeRepository(first.repository.id, { acknowledgeDependentSessions: true })
    const remaining = h.service.listRepositories()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.repository.id).toBe(second.repository.id)
  })

  it('clears an active session that belongs to the deleted repository', async () => {
    const h = harness()
    const { repoId } = await withSession(h)
    const [stored] = h.stores.sessions.listForRepo(repoId)
    if (!stored) throw new Error('missing stored session')
    h.stores.uiState.setActiveSession(stored.id)
    expect(h.stores.uiState.getActiveSession()).toBe(stored.id)
    h.service.removeRepository(repoId, { acknowledgeDependentSessions: true })
    expect(h.stores.uiState.getActiveSession()).toBeNull()
  })

  it('clears the active repository selection when it is deleted', async () => {
    const h = harness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)
    const added = await h.service.addRepository(repoPath)
    expect(h.stores.uiState.getActiveRepository()).toBe(added.repository.id)
    h.service.removeRepository(added.repository.id, { acknowledgeDependentSessions: true })
    expect(h.stores.uiState.getActiveRepository()).toBeNull()
  })
})

/**
 * The production boundary: a caller-supplied WSL target is validated against the
 * real registry before it can reach storage, and the *proven* target is what
 * gets persisted.
 */
describe('WSL target acceptance', () => {
  const UBUNTU_ID = 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
  const REGISTRY = [
    `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{${UBUNTU_ID}}`,
    '    DistributionName    REG_SZ    Ubuntu-26.04',
    '    Version    REG_DWORD    0x2'
  ].join('\r\n')

  function wslHarness(registry: string | null = REGISTRY): Harness {
    const root = makeTempRoot('icode-repo-wsl-')
    const db = openTempDatabase(root)
    const stores = makeRepositoryService(db, {
      validateTarget: realValidator(registry),
      resolveRoot: async (path) => resolveRepositoryRoot(path)
    })
    const value = { root, db, service: stores.service, stores }
    active.push(value)
    return value
  }

  function realValidator(registry: string | null) {
    const launcher: WslProcessLauncher = async () => ({
      code: 0,
      signal: null,
      stdout: 'Ubuntu-26.04\n',
      stderr: '',
      timedOut: false
    })
    return createTargetValidator({
      runner: new WslCommandRunner({ launcher, platform: 'win32' }),
      platform: 'win32',
      queryRegistry: async () => registry
    })
  }

  it('persists the registration id a caller did not supply, then dedupes by it', async () => {
    const h = wslHarness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)

    const first = await h.service.addRepository(repoPath, {
      kind: 'wsl',
      distro: 'Ubuntu-26.04',
      distroId: null
    })
    expect(first.created).toBe(true)
    // The id was absent on the way in and is proven on the way out.
    expect(first.repository.executionTarget).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu-26.04',
      distroId: UBUNTU_ID
    })

    // A second add of the same path, now carrying the id, is the same row.
    const again = await h.service.addRepository(repoPath, {
      kind: 'wsl',
      distro: 'Ubuntu-26.04',
      distroId: UBUNTU_ID
    })
    expect(again.created).toBe(false)
    expect(again.repository.id).toBe(first.repository.id)
    expect(h.service.listRepositories()).toHaveLength(1)
  })

  it('rejects a missing distro and stores nothing', async () => {
    const h = wslHarness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)

    await expect(
      h.service.addRepository(repoPath, { kind: 'wsl', distro: 'Ubuntu-99.99', distroId: null })
    ).rejects.toMatchObject({ appError: { code: 'WSL_DISTRO_NOT_FOUND' } })
    expect(h.service.listRepositories()).toHaveLength(0)
  })

  it('rejects a replaced registration and stores nothing', async () => {
    const h = wslHarness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)

    await expect(
      h.service.addRepository(repoPath, {
        kind: 'wsl',
        distro: 'Ubuntu-26.04',
        distroId: 'ffffffff-1111-2222-3333-444455556666'
      })
    ).rejects.toMatchObject({ appError: { code: 'WSL_DISTRO_NOT_FOUND' } })
    expect(h.service.listRepositories()).toHaveLength(0)
  })

  it('reports an unreadable registry as retryable rather than as a missing distro', async () => {
    const h = wslHarness(null)
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)

    await expect(
      h.service.addRepository(repoPath, { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: null })
    ).rejects.toMatchObject({ appError: { code: 'WSL_UNAVAILABLE', retryable: true } })
    expect(h.service.listRepositories()).toHaveLength(0)
  })

  it('reports the gone distro, not the path error it causes, when the path does not resolve', async () => {
    const h = wslHarness()
    // Validation runs first, so the actionable cause wins over PATH_NOT_FOUND.
    await expect(
      h.service.addRepository(join(h.root.dir, 'does-not-exist'), {
        kind: 'wsl',
        distro: 'Ubuntu-99.99',
        distroId: null
      })
    ).rejects.toMatchObject({ appError: { code: 'WSL_DISTRO_NOT_FOUND' } })
    expect(h.service.listRepositories()).toHaveLength(0)
  })

  it('leaves local registration untouched, including a local row at the same path', async () => {
    const h = wslHarness()
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)

    const local = await h.service.addRepository(repoPath)
    const wsl = await h.service.addRepository(repoPath, {
      kind: 'wsl',
      distro: 'Ubuntu-26.04',
      distroId: null
    })

    expect(local.created).toBe(true)
    expect(wsl.created).toBe(true)
    expect(local.repository.executionTarget).toEqual({ kind: 'local' })
    expect(local.repository.id).not.toBe(wsl.repository.id)
    // The local row survives a WSL registration at the same path.
    expect(h.service.getRepository(local.repository.id)?.repository.executionTarget).toEqual({
      kind: 'local'
    })
  })
})

/**
 * AC-05: a WSL row written before a registration id could be read.
 *
 * The row names its distro by name only. A later add carries the proven id, so
 * the two must be recognised as one repository — but only with evidence, because
 * a name survives an unregister + reimport while the repository behind it may not.
 */
describe('legacy WSL rows without a registration id', () => {
  const ID = 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'

  /** A harness whose guest resolver reports a fixed common dir for one path. */
  function legacyHarness(commonDir: string) {
    const root = makeTempRoot('icode-w6-legacy-')
    const db = openTempDatabase(root)
    const stores = makeRepositoryService(db, {
      resolveRoot: async (path) => ({
        root: path,
        currentBranch: 'main',
        commonDir
      })
    })
    const value = { root, db, service: stores.service, stores }
    active.push(value)
    return value
  }

  /** Writes the pre-W1 shape directly: a WSL row with no registration id. */
  function writeLegacyRow(h: Harness, path: string, commonDir: string | null): string {
    const id = newRepoId()
    h.stores.repositories.insert({
      id,
      path: path as never,
      displayName: 'legacy',
      addedAt: 1,
      lastOpenedAt: 1,
      currentBranch: 'main',
      availability: 'present',
      gitCommonDir: commonDir,
      executionTarget: { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: null }
    })
    // Every repository owns exactly one primary-checkout workspace; a legacy row
    // is no exception, and the schema enforces it.
    h.stores.repositories.insertWorkspace({
      id: newWorkspaceId(),
      repoId: id,
      path: path as never,
      kind: 'primary-checkout',
      createdAt: 1
    })
    return id
  }

  it('completes the id in place when the common dir proves the same repository', async () => {
    const h = legacyHarness('/home/u/src/atlas/.git')
    const legacyId = writeLegacyRow(h, '/home/u/src/atlas', '/home/u/src/atlas/.git')

    const added = await h.service.addRepository('/home/u/src/atlas', {
      kind: 'wsl',
      distro: 'Ubuntu-26.04',
      distroId: ID
    })

    // One repository, the same row, no cascade.
    expect(added.created).toBe(false)
    expect(added.repository.id).toBe(legacyId)
    expect(added.repository.executionTarget).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu-26.04',
      distroId: ID
    })
    expect(h.service.listRepositories()).toHaveLength(1)
    // The id is now durable, so later lookups find the row by registration.
    expect(
      h.stores.repositories.findByPath('/home/u/src/atlas', {
        kind: 'wsl',
        distro: 'Ubuntu-26.04',
        distroId: ID
      })?.id
    ).toBe(legacyId)
  })

  it('refuses to rebind when the common dir does not match', async () => {
    const h = legacyHarness('/home/u/src/atlas/.git')
    writeLegacyRow(h, '/home/u/src/atlas', '/home/u/other/.git')

    await expect(
      h.service.addRepository('/home/u/src/atlas', {
        kind: 'wsl',
        distro: 'Ubuntu-26.04',
        distroId: ID
      })
    ).rejects.toMatchObject({ appError: { code: 'WSL_LEGACY_REGISTRATION_UNRESOLVED' } })

    // Nothing was written: the legacy row is untouched and no duplicate appeared.
    expect(h.service.listRepositories()).toHaveLength(1)
    expect(h.service.listRepositories()[0]!.repository.executionTarget).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu-26.04',
      distroId: null
    })
  })

  it('refuses when the legacy row recorded no common dir at all', async () => {
    const h = legacyHarness('/home/u/src/atlas/.git')
    writeLegacyRow(h, '/home/u/src/atlas', null)
    await expect(
      h.service.addRepository('/home/u/src/atlas', {
        kind: 'wsl',
        distro: 'Ubuntu-26.04',
        distroId: ID
      })
    ).rejects.toMatchObject({ appError: { code: 'WSL_LEGACY_REGISTRATION_UNRESOLVED' } })
  })

  it('does not adopt a legacy row that belongs to a different distro name', async () => {
    const h = legacyHarness('/home/u/src/atlas/.git')
    writeLegacyRow(h, '/home/u/src/atlas', '/home/u/src/atlas/.git')

    const added = await h.service.addRepository('/home/u/src/atlas', {
      kind: 'wsl',
      distro: 'Ubuntu-24.04',
      distroId: 'bbbbbbbb-1111-2222-3333-444455556666'
    })
    // A different distro is a different repository, so a second row is correct.
    expect(added.created).toBe(true)
    expect(h.service.listRepositories()).toHaveLength(2)
  })

  it('leaves local rows and local dedupe untouched', async () => {
    const h = legacyHarness('/home/u/src/atlas/.git')
    const repoPath = join(h.root.dir, 'atlas')
    initGitRepo(repoPath)
    const first = await h.service.addRepository(repoPath)
    const second = await h.service.addRepository(repoPath)
    expect(second.created).toBe(false)
    expect(second.repository.id).toBe(first.repository.id)
    expect(first.repository.executionTarget).toEqual({ kind: 'local' })
  })
})

/**
 * Work 81: a WSL project must not be labelled missing because its path was
 * checked on Windows, and an unreachable distro must not read as "gone".
 */
describe('remote project availability', () => {
  it('never derives a WSL project\'s availability from the local filesystem', async () => {
    const f = harness()
    const guestPath = '/home/u/projects/atlas'
    // Store the row directly: registration is covered elsewhere, and the point
    // here is the *list* path, which used to stat the guest path locally.
    const repoId = newRepoId()
    f.stores.repositories.insert({
      id: repoId,
      path: guestPath as never,
      displayName: 'atlas',
      addedAt: 1,
      lastOpenedAt: 1,
      currentBranch: 'main',
      availability: 'present',
      gitCommonDir: null,
      executionTarget: {
        kind: 'wsl',
        distro: 'Ubuntu-26.04',
        distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
      }
    })
    // A repository always owns one primary checkout; the list assumes it.
    f.stores.repositories.insertWorkspace({
      id: newWorkspaceId(),
      repoId,
      path: guestPath as never,
      kind: 'primary-checkout',
      createdAt: 1
    })

    // Without a host check the answer must stay as recorded, not become missing.
    const listed = f.service.listRepositories()
    expect(listed[0]?.repository.availability).toBe('present')

    // A distro that cannot answer is `unknown`, and is not written to the row.
    f.service.useHostFs(async () => ({
      isDirectory: async () => {
        throw new Error('the distro did not answer')
      }
    }))
    await f.service.refreshTargetAvailability()
    const unknown = f.service.listRepositories()
    expect(unknown[0]?.repository.availability).toBe('unknown')
    expect(f.stores.repositories.findById(unknown[0]!.repository.id)?.availability).toBe('present')

    // A definite answer is applied and persisted.
    f.service.useHostFs(async () => ({ isDirectory: async () => false }))
    await f.service.refreshTargetAvailability()
    const missing = f.service.listRepositories()
    expect(missing[0]?.repository.availability).toBe('missing')
    expect(f.stores.repositories.findById(missing[0]!.repository.id)?.availability).toBe('missing')
  })
})
