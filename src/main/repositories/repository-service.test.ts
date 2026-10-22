import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import type { TempRoot } from '../persistence/persistence-test-fixtures'
import { newRepoId, newSessionId, newWorkspaceId } from '../../shared/domain/ids'
import type { Database } from '../persistence/database'

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
    ['-C', path, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.test', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { stdio: 'pipe' }
  )
}

function harness(): Harness {
  const root = makeTempRoot('ade-repo-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
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
