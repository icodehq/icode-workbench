import { describe, expect, it } from 'vitest'
import { repositorySummarySchema } from '../../shared/schemas/ipc'
import type { RepositoryRecord } from '../../shared/domain/repository'
import { newRepoId } from '../../shared/domain/ids'
import { toCanonicalRepositoryPath } from '../../shared/domain/paths'
import { toRepositorySummary } from './repository-summary'

function record(overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  return {
    id: newRepoId(),
    path: toCanonicalRepositoryPath('/home/you/atlas'),
    displayName: 'atlas',
    addedAt: 1,
    lastOpenedAt: 1,
    currentBranch: 'main',
    availability: 'present',
    gitCommonDir: '/home/you/atlas/.git',
    executionTarget: { kind: 'local' },
    ...overrides
  }
}

/**
 * The mapper is the only thing between a persisted row and the renderer, and the
 * schema promises `target` is always present. A real UI run caught `repos.list`
 * omitting it while `repos.add` sent it, which left the renderer unable to say
 * where a repository lives.
 */
describe('repository summary payload', () => {
  it('is valid on the wire for a local repository', () => {
    const summary = toRepositorySummary(record())
    expect(repositorySummarySchema.parse(summary)).toEqual(summary)
    expect(summary.target).toEqual({ kind: 'local' })
  })

  it('carries the persisted WSL distro and registration', () => {
    const summary = toRepositorySummary(
      record({
        path: toCanonicalRepositoryPath('/home/you/atlas'),
        executionTarget: {
          kind: 'wsl',
          distro: 'Ubuntu-26.04',
          distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
        }
      })
    )
    expect(repositorySummarySchema.parse(summary).target).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu-26.04',
      distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
    })
  })

  it('keeps an id-less WSL target honest instead of inventing an id', () => {
    const summary = toRepositorySummary(
      record({ executionTarget: { kind: 'wsl', distro: 'Debian', distroId: null } })
    )
    expect(summary.target).toEqual({ kind: 'wsl', distro: 'Debian', distroId: null })
  })

  it('never derives the target from the path', () => {
    // The same path string is legal for both targets; only the row decides.
    const samePath = toCanonicalRepositoryPath('/home/you/atlas')
    const asLocal = toRepositorySummary(record({ path: samePath }))
    const asWsl = toRepositorySummary(
      record({
        path: samePath,
        executionTarget: { kind: 'wsl', distro: 'Ubuntu', distroId: null }
      })
    )
    expect(asLocal.target.kind).toBe('local')
    expect(asWsl.target.kind).toBe('wsl')
  })
})
