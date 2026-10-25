import { LOCAL_EXECUTION_TARGET } from '../../shared/domain/repository'
import { describe, expect, it } from 'vitest'
import {
  MAX_PATH_LENGTH,
  isAbsolutePathLike,
  toCanonicalRepositoryPath
} from './paths'
import { assertWorkspaceMatchesRepository, isRepositoryUsable } from './repository'
import type { RepositoryRecord, WorkspaceRecord } from './repository'
import { newRepoId, newWorkspaceId } from './ids'

describe('absolute path validation', () => {
  it('accepts POSIX, drive-letter, and UNC shapes', () => {
    expect(isAbsolutePathLike('/home/dev/repos/atlas')).toBe(true)
    expect(isAbsolutePathLike('C:\\code\\atlas')).toBe(true)
    expect(isAbsolutePathLike('C:/code/atlas')).toBe(true)
    expect(isAbsolutePathLike('\\\\server\\share\\atlas')).toBe(true)
  })

  it('rejects relative, empty, NUL, and oversized values', () => {
    expect(isAbsolutePathLike('repos/atlas')).toBe(false)
    expect(isAbsolutePathLike('')).toBe(false)
    expect(isAbsolutePathLike('/tmp/at\0las')).toBe(false)
    expect(isAbsolutePathLike(`/${'a'.repeat(MAX_PATH_LENGTH)}`)).toBe(false)
  })

  it('brands only absolute paths', () => {
    expect(toCanonicalRepositoryPath('/tmp/atlas')).toBe('/tmp/atlas')
    expect(() => toCanonicalRepositoryPath('atlas')).toThrow('must be absolute')
  })
})

describe('repository and workspace invariants', () => {
  const repo: RepositoryRecord = {
    id: newRepoId(),
    path: toCanonicalRepositoryPath('/tmp/atlas'),
    displayName: 'atlas',
    addedAt: 1,
    lastOpenedAt: 2,
    currentBranch: 'main',
    availability: 'present',
      gitCommonDir: null,
      executionTarget: LOCAL_EXECUTION_TARGET
  }

  const workspace: WorkspaceRecord = {
    id: newWorkspaceId(),
    repoId: repo.id,
    path: toCanonicalRepositoryPath('/tmp/atlas'),
    kind: 'primary-checkout',
    createdAt: 3
  }

  it('treats only present repositories as usable', () => {
    expect(isRepositoryUsable(repo)).toBe(true)
    expect(isRepositoryUsable({ ...repo, availability: 'missing' })).toBe(false)
  })

  it('accepts a workspace that belongs to its repository', () => {
    expect(() => assertWorkspaceMatchesRepository(workspace, repo)).not.toThrow()
  })

  it('rejects a workspace from another repository', () => {
    const other = { ...repo, id: newRepoId() }
    expect(() => assertWorkspaceMatchesRepository(workspace, other)).toThrow(
      'does not belong to the repository'
    )
  })
})
