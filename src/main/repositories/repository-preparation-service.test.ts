import { describe, expect, it, vi } from 'vitest'
import type {
  RepositoryPreparation,
  RepositoryRecord
} from '../../shared/domain/repository'
import { makeAppError } from '../../shared/domain/errors'
import { newRepoId, type RepoId } from '../../shared/domain/ids'
import { toCanonicalRepositoryPath } from '../../shared/domain/paths'
import type { FirstCommitResult } from './first-commit'
import { RepositoryPreparationError } from './first-commit'
import { RepositoryPreparationService } from './repository-preparation-service'

function repository(preparation: RepositoryPreparation | null = null): RepositoryRecord {
  return {
    id: newRepoId(),
    path: toCanonicalRepositoryPath('/work/project'),
    displayName: 'project',
    addedAt: 1,
    lastOpenedAt: 1,
    currentBranch: null,
    availability: 'present',
    gitCommonDir: '/work/project/.git',
    executionTarget: { kind: 'local' },
    preparation
  }
}

function fakeStore(initial: RepositoryRecord[]): {
  list: () => RepositoryRecord[]
  updatePreparation: (id: RepoId, preparation: RepositoryPreparation) => void
  updateBranch: (id: RepoId, branch: string | null) => void
  rows: Map<string, RepositoryRecord>
} {
  const rows = new Map(initial.map((entry) => [entry.id, entry]))
  return {
    rows,
    list: () => [...rows.values()],
    updatePreparation: (id, preparation) => {
      const entry = rows.get(id)
      if (entry) rows.set(id, { ...entry, preparation })
    },
    updateBranch: (id, branch) => {
      const entry = rows.get(id)
      if (entry) rows.set(id, { ...entry, currentBranch: branch })
    }
  }
}

function result(overrides: Partial<FirstCommitResult> = {}): FirstCommitResult {
  return {
    alreadyCommitted: false,
    committedFiles: 3,
    skippedFolders: ['node_modules/'],
    branch: 'main',
    createdGitignore: true,
    ...overrides
  }
}

describe('repository preparation service', () => {
  it('persists preparing immediately and ready after the job settles', async () => {
    const repo = repository()
    const store = fakeStore([repo])
    const onChange = vi.fn()
    let resolvePrepare!: (value: FirstCommitResult) => void
    const prepare = vi.fn(
      () =>
        new Promise<FirstCommitResult>((resolve) => {
          resolvePrepare = resolve
        })
    )
    const service = new RepositoryPreparationService({
      repositories: store,
      prepare,
      now: () => 100,
      onChange
    })

    const started = service.start(repo)

    expect(started.state).toBe('preparing')
    expect(store.rows.get(repo.id)?.preparation?.state).toBe('preparing')
    expect(onChange).toHaveBeenCalledTimes(1)

    resolvePrepare(result())
    await service.waitForIdle()

    expect(store.rows.get(repo.id)?.preparation).toMatchObject({
      state: 'ready',
      committedFiles: 3,
      skippedFolders: ['node_modules/'],
      error: null
    })
    expect(store.rows.get(repo.id)?.currentBranch).toBe('main')
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('records a failed preparation with the actionable error', async () => {
    const repo = repository()
    const store = fakeStore([repo])
    const appError = makeAppError('GIT_COMMIT_FAILED', 'Git could not commit.')
    const service = new RepositoryPreparationService({
      repositories: store,
      prepare: async () => {
        throw new RepositoryPreparationError(appError)
      },
      now: () => 200,
      onChange: vi.fn()
    })

    service.start(repo)
    await service.waitForIdle()

    expect(store.rows.get(repo.id)?.preparation).toMatchObject({
      state: 'failed',
      committedFiles: null,
      error: appError
    })
  })

  it('resumes a persisted preparing row after an application restart', async () => {
    const repo = repository({
      state: 'preparing',
      startedAt: 1,
      finishedAt: null,
      committedFiles: null,
      skippedFolders: [],
      error: null
    })
    const store = fakeStore([repo])
    const prepare = vi.fn(async () => result())
    const service = new RepositoryPreparationService({
      repositories: store,
      prepare,
      now: () => 300,
      onChange: vi.fn()
    })

    service.resume()
    await service.waitForIdle()

    expect(prepare).toHaveBeenCalledTimes(1)
    expect(store.rows.get(repo.id)?.preparation?.state).toBe('ready')
  })

  it('joins a running job instead of preparing the same repository twice', async () => {
    const repo = repository()
    const store = fakeStore([repo])
    let resolvePrepare!: (value: FirstCommitResult) => void
    const prepare = vi.fn(
      () =>
        new Promise<FirstCommitResult>((resolve) => {
          resolvePrepare = resolve
        })
    )
    const service = new RepositoryPreparationService({
      repositories: store,
      prepare,
      now: () => 400,
      onChange: vi.fn()
    })

    service.start(repo)
    service.start(repo)
    resolvePrepare(result())
    await service.waitForIdle()

    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('does not commit after the project was cancelled', async () => {
    const repo = repository()
    const store = fakeStore([repo])
    let resolvePrepare!: (value: FirstCommitResult) => void
    const prepare = vi.fn(
      () =>
        new Promise<FirstCommitResult>((resolve) => {
          resolvePrepare = resolve
        })
    )
    const service = new RepositoryPreparationService({
      repositories: store,
      prepare,
      now: () => 500,
      onChange: vi.fn()
    })

    service.start(repo)
    service.cancel(repo.id)
    resolvePrepare(result())
    await service.waitForIdle()

    expect(store.rows.get(repo.id)?.preparation?.state).toBe('preparing')
  })
})
