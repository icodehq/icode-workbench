import { describe, expect, it } from 'vitest'
import type { ActivitySummary } from '../../../shared/domain/activity'
import type { HarnessDetection } from '../../../shared/domain/harness'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import {
  activeRepo,
  activeSession,
  availableHarnesses,
  createInitialState,
  pendingAction,
  workspaceReducer,
  type WorkspaceState
} from './workspace'

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
    harness: 'shell',
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
const sessions = [
  session('ses_one', 'repo_a'),
  session('ses_two', 'repo_a'),
  session('ses_three', 'repo_b')
]

function loaded(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  let state = createInitialState()
  state = workspaceReducer(state, { type: 'booted' })
  state = workspaceReducer(state, { type: 'reposLoaded', repos })
  state = workspaceReducer(state, {
    type: 'sessionsLoaded',
    sessions,
    orphans: []
  })
  return { ...state, ...overrides }
}

function detection(harness: HarnessDetection['harness'], state: HarnessDetection['state']): HarnessDetection {
  const diagnostics = {
    resolvedPath: null,
    outcome: 'spawn_error' as const,
    exitCode: null,
    signal: null,
    stdoutTail: '',
    stderrTail: '',
    durationMs: 1,
    observedAt: 1,
    attempts: 1
  }
  if (state === 'available') {
    return {
      state,
      harness,
      version: '1.0.0',
      resolvedPath: `/usr/bin/${harness}`,
      diagnostics
    }
  }
  if (state === 'unavailable') {
    return {
      state,
      harness,
      reason: 'not_found',
      incompatibility: null,
      message: 'Executable not found on PATH',
      diagnostics
    }
  }
  return {
    state,
    harness,
    reason: 'timeout',
    message: 'Version probe timed out',
    diagnostics
  }
}

describe('workspace loading and selection', () => {
  it('starts on the first repository and keeps its first session', () => {
    const state = loaded()
    expect(activeRepo(state)?.id).toBe('repo_a')
    expect(activeSession(state)?.id).toBe('ses_one')
    expect(state.boot).toBe('ready')
  })

  it('honours a stored selection that still exists', () => {
    let state = createInitialState({ repoId: 'repo_b', sessionId: 'ses_three' })
    state = workspaceReducer(state, { type: 'reposLoaded', repos })
    state = workspaceReducer(state, { type: 'sessionsLoaded', sessions, orphans: [] })
    expect(activeRepo(state)?.id).toBe('repo_b')
    expect(activeSession(state)?.id).toBe('ses_three')
  })

  it('falls back when a stored selection is stale', () => {
    let state = createInitialState({ repoId: 'repo_gone', sessionId: 'ses_gone' })
    state = workspaceReducer(state, { type: 'reposLoaded', repos })
    state = workspaceReducer(state, { type: 'sessionsLoaded', sessions, orphans: [] })
    expect(activeRepo(state)?.id).toBe('repo_a')
    expect(activeSession(state)?.id).toBe('ses_one')
  })

  it('switching repository selects one of its sessions, never stopping another', () => {
    let state = loaded()
    state = workspaceReducer(state, { type: 'selectRepo', repoId: 'repo_b' })
    expect(activeSession(state)?.id).toBe('ses_three')
    expect(state.sessions).toHaveLength(3)
    expect(state.pending).toEqual({})
  })

  it('selecting a session also selects its repository', () => {
    let state = loaded({ activeRepoId: 'repo_a' })
    state = workspaceReducer(state, { type: 'selectSession', sessionId: 'ses_three' })
    expect(state.activeRepoId).toBe('repo_b')
    expect(activeSession(state)?.id).toBe('ses_three')
  })

  it('ignores selections for unknown repositories or sessions', () => {
    const state = loaded()
    expect(workspaceReducer(state, { type: 'selectRepo', repoId: 'repo_missing' })).toBe(state)
    expect(workspaceReducer(state, { type: 'selectSession', sessionId: 'ses_missing' })).toBe(state)
  })
})

describe('session updates', () => {
  it('updates an existing session in place and appends a new one once', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'sessionUpserted',
      session: session('ses_one', 'repo_a', { state: 'exited', exitCode: 0 })
    })
    expect(state.sessions).toHaveLength(3)
    expect(activeSession(state)?.state).toBe('exited')

    state = workspaceReducer(state, {
      type: 'sessionUpserted',
      session: session('ses_four', 'repo_b')
    })
    expect(state.sessions).toHaveLength(4)
  })

  it('drops a stopping marker once the process reaches a terminal state', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'pendingSet',
      sessionId: 'ses_two',
      action: 'stopping'
    })
    expect(pendingAction(state, 'ses_two')).toBe('stopping')

    state = workspaceReducer(state, {
      type: 'sessionUpserted',
      session: session('ses_two', 'repo_a', { state: 'exited', exitCode: 129 })
    })
    expect(pendingAction(state, 'ses_two')).toBeNull()
  })

  it('keeps a stopping marker while the event still reports live', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'pendingSet',
      sessionId: 'ses_two',
      action: 'stopping'
    })
    state = workspaceReducer(state, {
      type: 'sessionUpserted',
      session: session('ses_two', 'repo_a', { state: 'live' })
    })
    expect(pendingAction(state, 'ses_two')).toBe('stopping')
  })

  it('clears pending markers for sessions that disappeared on refresh', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'pendingSet',
      sessionId: 'ses_two',
      action: 'stopping'
    })
    state = workspaceReducer(state, {
      type: 'sessionsLoaded',
      sessions: sessions.filter((entry) => entry.id !== 'ses_two'),
      orphans: []
    })
    expect(pendingAction(state, 'ses_two')).toBeNull()
    expect(state.sessions).toHaveLength(2)
  })

  it('removes an acknowledged session immediately and selects the next one', () => {
    let state = loaded({ activeSessionId: 'ses_two' })
    state = workspaceReducer(state, {
      type: 'pendingSet',
      sessionId: 'ses_two',
      action: 'removing'
    })
    state = workspaceReducer(state, {
      type: 'sessionCleanup',
      prompt: {
        sessionId: 'ses_two',
        title: 'ses_two',
        branch: 'icode/ses_two',
        blocker: null
      }
    })
    state = workspaceReducer(state, { type: 'sessionRemoved', sessionId: 'ses_two' })
    expect(state.sessions.map((entry) => entry.id)).toEqual(['ses_one', 'ses_three'])
    expect(activeSession(state)?.id).toBe('ses_one')
    expect(pendingAction(state, 'ses_two')).toBeNull()
    expect(state.sessionCleanup).toBeNull()
  })

  it('starts an explicit restart marker and clears it on request completion', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'pendingSet',
      sessionId: 'ses_one',
      action: 'restarting'
    })
    expect(pendingAction(state, 'ses_one')).toBe('restarting')
    state = workspaceReducer(state, { type: 'pendingClear', sessionId: 'ses_one' })
    expect(pendingAction(state, 'ses_one')).toBeNull()
  })
})

describe('harness detection and notices', () => {
  it('exposes only actually available harnesses as selectable', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'harnessesLoaded',
      harnesses: [
        detection('claude', 'available'),
        detection('codex', 'unavailable'),
        detection('opencode', 'detection_failed'),
        detection('shell', 'available')
      ]
    })
    expect(availableHarnesses(state).map((entry) => entry.harness)).toEqual(['claude', 'shell'])
    expect(state.harnessLoading).toBe(false)
  })

  it('keeps a detection failure observable and clearable on retry', () => {
    let state = loaded()
    state = workspaceReducer(state, { type: 'harnessesLoading' })
    state = workspaceReducer(state, {
      type: 'harnessFailed',
      error: { code: 'HARNESS_DETECTION_FAILED', message: 'Probe failed', retryable: true }
    })
    expect(state.harnessError?.code).toBe('HARNESS_DETECTION_FAILED')
    state = workspaceReducer(state, { type: 'harnessesLoaded', harnesses: [] })
    expect(state.harnessError).toBeNull()
    expect(state.harnesses).toEqual([])
  })

  it('stores and clears a feedback notice', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'notice',
      notice: { tone: 'error', message: 'Registration failed' }
    })
    expect(state.notice?.message).toBe('Registration failed')
    state = workspaceReducer(state, { type: 'notice', notice: null })
    expect(state.notice).toBeNull()
  })

  it('contains repository-removal confirmation details', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'removalPrompt',
      prompt: {
        repoId: 'repo_a',
        repoName: 'alpha',
        sessions: sessions.filter((entry) => entry.repoId === 'repo_a')
      }
    })
    expect(state.removal?.sessions).toHaveLength(2)
    state = workspaceReducer(state, { type: 'removalPrompt', prompt: null })
    expect(state.removal).toBeNull()
  })

  it('tracks boot failure without discarding loaded data', () => {
    let state = loaded()
    state = workspaceReducer(state, { type: 'bootFailed', message: 'Database error' })
    expect(state.boot).toBe('failed')
    expect(state.bootError).toBe('Database error')
    expect(state.repos).toHaveLength(2)
  })
})

describe('worktree lifecycle state', () => {
  it('stores retained branches and clears them when the repository changes', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'branchesLoaded',
      branches: [
        {
          branch: 'icode/ses_one',
          repoId: 'repo_a',
          sessionId: 'ses_one',
          baseOid: 'abc',
          createdAt: 1,
          exists: true,
          unmergedCommits: 2,
          worktreePath: null
        }
      ]
    })
    expect(state.branches).toHaveLength(1)
    expect(state.branches[0]!.unmergedCommits).toBe(2)
  })

  it('opens and closes a cleanup prompt with its blocker', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'sessionCleanup',
      prompt: {
        sessionId: 'ses_one',
        title: 'alpha',
        branch: 'icode/ses_one',
        blocker: { kind: 'dirty', files: ['a.ts'] }
      }
    })
    expect(state.sessionCleanup?.blocker?.kind).toBe('dirty')
    state = workspaceReducer(state, { type: 'sessionCleanup', prompt: null })
    expect(state.sessionCleanup).toBeNull()
  })

  it('clears a cleanup prompt when its session disappears', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'sessionCleanup',
      prompt: {
        sessionId: 'ses_one',
        title: 'alpha',
        branch: 'icode/ses_one',
        blocker: { kind: 'unmerged', commits: 1 }
      }
    })
    state = workspaceReducer(state, {
      type: 'sessionsLoaded',
      sessions: sessions.filter((entry) => entry.id !== 'ses_one'),
      orphans: []
    })
    expect(state.sessionCleanup).toBeNull()
  })

  it('tracks an unmerged branch confirmation prompt', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'branchCleanup',
      prompt: { repoId: 'repo_a', branch: 'icode/ses_two', commits: 3 }
    })
    expect(state.branchCleanup).toEqual({
      repoId: 'repo_a',
      branch: 'icode/ses_two',
      commits: 3
    })
    state = workspaceReducer(state, { type: 'branchCleanup', prompt: null })
    expect(state.branchCleanup).toBeNull()
  })

  it('remembers that stale worktree metadata is shown, not guessed', () => {
    let state = loaded()
    state = workspaceReducer(state, {
      type: 'sessionUpserted',
      session: session('ses_one', 'repo_a', {
        worktree: {
          path: '/tmp/worktrees/a/ses_one',
          branch: 'icode/ses_one',
          baseOid: 'abc',
          state: 'ready',
          status: 'missing',
          error: null
        }
      })
    })
    expect(activeSession(state)?.worktree?.status).toBe('missing')
  })
})

describe('agent activity', () => {
  const working: ActivitySummary = {
    state: 'working',
    toolName: 'Bash',
    unread: false,
    outcome: null,
    since: 100
  }

  it('updates only the named session and never its lifecycle', () => {
    const before = loaded()
    const target = before.sessions.find((entry) => entry.id === 'ses_two')!
    const next = workspaceReducer(before, {
      type: 'activityUpdated',
      sessionId: 'ses_two',
      activity: working
    })
    const updated = next.sessions.find((entry) => entry.id === 'ses_two')!
    expect(updated.activity).toEqual(working)
    expect(updated.state).toBe(target.state)
    expect(updated.authority).toBe(target.authority)
    expect(updated.reason).toBe(target.reason)
    expect(updated.incarnationId).toBe(target.incarnationId)
    const untouched = next.sessions.find((entry) => entry.id === 'ses_one')!
    expect(untouched.activity).toBeNull()
  })

  it('does not leak activity between sessions or repos', () => {
    const before = loaded()
    const next = workspaceReducer(before, {
      type: 'activityUpdated',
      sessionId: 'ses_two',
      activity: { ...working, state: 'waiting', unread: true }
    })
    expect(next.sessions.filter((entry) => entry.activity !== null)).toHaveLength(1)
    expect(next.sessions.find((entry) => entry.id === 'ses_two')?.activity?.state).toBe('waiting')
    expect(next.sessions.find((entry) => entry.id === 'ses_three')?.activity).toBeNull()
  })

  it('ignores activity for a session that is no longer listed', () => {
    const before = loaded()
    const next = workspaceReducer(before, {
      type: 'activityUpdated',
      sessionId: 'ses_gone',
      activity: working
    })
    expect(next).toBe(before)
  })

  it('is a no-op when the summary is unchanged', () => {
    const once = workspaceReducer(loaded(), {
      type: 'activityUpdated',
      sessionId: 'ses_two',
      activity: working
    })
    const twice = workspaceReducer(once, {
      type: 'activityUpdated',
      sessionId: 'ses_two',
      activity: { ...working }
    })
    expect(twice).toBe(once)
  })
})
