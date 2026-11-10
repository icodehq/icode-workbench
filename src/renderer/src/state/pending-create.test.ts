import { describe, expect, it } from 'vitest'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import {
  createPendingCreate,
  pendingCreateForRepo,
  pendingCreateStillVisible
} from './pending-create'

function repo(id: string, name = id): RepositorySummary {
  return {
    id,
    displayName: name,
    path: `/work/${name}`,
    currentBranch: 'main',
    availability: 'present',
    target: { kind: 'local' },
    preparation: null
  }
}

function session(
  id: string,
  repoId: string,
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id,
    repoId,
    title: id,
    harness: 'claude',
    state: 'live',
    authority: 'host',
    reason: 'host_live',
    incarnationId: 'abcdef1234567890',
    exitCode: null,
    error: null,
    updatedAt: 1,
    worktree: null,
    activity: null,
    ...overrides
  }
}

const repos = [repo('repo_a', 'alpha'), repo('repo_b', 'beta')]

describe('pending create descriptor', () => {
  it('normalizes an explicit title the same way the main process does', () => {
    const pending = createPendingCreate(
      { repoId: 'repo_a', harness: 'claude', title: '  Fix   the\ncheckout  ' },
      repos,
      1_000
    )
    expect(pending.title).toBe('Fix the checkout')
    expect(pending.repoId).toBe('repo_a')
    expect(pending.harness).toBe('claude')
    expect(pending.startedAt).toBe(1_000)
  })

  it('builds the default title from the harness and repository', () => {
    const pending = createPendingCreate({ repoId: 'repo_a', harness: 'claude' }, repos, 1_000)
    expect(pending.title).toBe('Claude Code · alpha')
  })

  it('falls back to the generic repository label when the repo is unknown', () => {
    const pending = createPendingCreate({ repoId: 'repo_missing', harness: 'codex' }, repos, 1_000)
    expect(pending.title).toBe('Codex · repository')
  })

  it('gives every submit a distinct nonce', () => {
    const first = createPendingCreate({ repoId: 'repo_a', harness: 'claude' }, repos, 1_000)
    const second = createPendingCreate({ repoId: 'repo_a', harness: 'claude' }, repos, 1_000)
    expect(first.id).not.toBe(second.id)
  })

  it('filters by repository without touching a different one', () => {
    const pending = createPendingCreate({ repoId: 'repo_a', harness: 'claude' }, repos, 1_000)
    expect(pendingCreateForRepo(pending, 'repo_a')).toBe(pending)
    expect(pendingCreateForRepo(pending, 'repo_b')).toBeNull()
    expect(pendingCreateForRepo(null, 'repo_a')).toBeNull()
  })
})

describe('pending surface visibility', () => {
  const pending = createPendingCreate(
    { repoId: 'repo_a', harness: 'claude', title: 'Claude Code · alpha' },
    repos,
    1_000
  )

  it('hides once a matching non-failed session exists', () => {
    const real = session('ses_new', 'repo_a', {
      title: 'Claude Code · alpha',
      harness: 'claude',
      updatedAt: 1_000
    })
    expect(pendingCreateStillVisible(pending, [real])).toBe(false)
  })

  it('stays visible for a failed row, whose outcome is still being reported', () => {
    const failed = session('ses_new', 'repo_a', {
      title: 'Claude Code · alpha',
      harness: 'claude',
      state: 'failed',
      updatedAt: 1_000
    })
    expect(pendingCreateStillVisible(pending, [failed])).toBe(true)
  })

  it('stays visible for an older same-title session', () => {
    const older = session('ses_old', 'repo_a', {
      title: 'Claude Code · alpha',
      harness: 'claude',
      updatedAt: 999
    })
    expect(pendingCreateStillVisible(pending, [older])).toBe(true)
  })

  it('ignores sessions with another repo, harness or title', () => {
    const otherRepo = session('ses_other', 'repo_b', {
      title: 'Claude Code · alpha',
      harness: 'claude',
      updatedAt: 1_000
    })
    const otherHarness = session('ses_codex', 'repo_a', {
      title: 'Claude Code · alpha',
      harness: 'codex',
      updatedAt: 1_000
    })
    const otherTitle = session('ses_title', 'repo_a', {
      title: 'Something else',
      harness: 'claude',
      updatedAt: 1_000
    })
    expect(pendingCreateStillVisible(pending, [otherRepo, otherHarness, otherTitle])).toBe(true)
  })
})
