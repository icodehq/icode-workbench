import { describe, expect, it } from 'vitest'
import { classifyGitFailure, isIndexLockFailure } from './git-errors'

describe('classifyGitFailure', () => {
  it.each([
    [
      'fatal: Unable to create /repo/.git/index.lock: File exists.\nAnother git process seems to be running in this repository',
      'GIT_INDEX_LOCKED',
      true
    ],
    ['fatal: Authentication failed for https://example.test/repo.git', 'GIT_AUTH_FAILED', false],
    ['! [rejected] main -> main (non-fast-forward)', 'GIT_NON_FAST_FORWARD', false],
    [
      'fatal: The current branch main and its upstream have diverged',
      'GIT_DIVERGED',
      false
    ],
    ['fatal: branch feature is already checked out at /worktrees/feature', 'GIT_BRANCH_IN_USE', false],
    [
      'CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed; fix conflicts and then commit the result.',
      'GIT_CONFLICT',
      false
    ]
  ] as const)('maps %s', (stderr, code, retryable) => {
    const error = classifyGitFailure(stderr)
    expect(error.code).toBe(code)
    expect(error.retryable).toBe(retryable)
    expect(error.detail).toContain(stderr.split('\n')[0]!.slice(0, 20))
  })

  it('uses the caller fallback and message when nothing matches', () => {
    const error = classifyGitFailure('fatal: something unexpected', {
      fallback: 'GIT_READ_FAILED',
      fallbackMessage: 'Git could not read this worktree.'
    })
    expect(error).toMatchObject({
      code: 'GIT_READ_FAILED',
      message: 'Git could not read this worktree.',
      retryable: true,
      detail: 'fatal: something unexpected'
    })
  })

  it('omits detail when stderr is empty', () => {
    const error = classifyGitFailure('   ')
    expect(error.code).toBe('GIT_COMMIT_FAILED')
    expect(error.detail).toBeUndefined()
    expect(error.retryable).toBe(false)
  })
})

describe('isIndexLockFailure', () => {
  it('matches the three ways Git describes a lock race', () => {
    expect(isIndexLockFailure('Unable to create index.lock')).toBe(true)
    expect(isIndexLockFailure('Another git process seems to be running')).toBe(true)
    expect(isIndexLockFailure('fatal: could not lock config file')).toBe(false)
  })
})
