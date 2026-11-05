import { describe, expect, it, vi } from 'vitest'
import { createDispatcher, type DispatcherServices } from './dispatcher'
import { IPC_CHANNELS } from '../../shared/schemas/ipc'
import { makeAppError } from '../../shared/domain/errors'
import { DatabaseError } from '../persistence/database'
import { SessionServiceError } from '../sessions/session-service'
import { RepositoryTargetError } from '../wsl/repository-target'
import { newRepoId, newSessionId } from '../../shared/domain/ids'

function services(overrides: Partial<DispatcherServices> = {}): DispatcherServices {
  return {
    reposList: vi.fn(async () => []),
    reposAdd: vi.fn(async () => ({})),
    reposInspect: vi.fn(async () => ({})),
    reposInitialize: vi.fn(async () => ({})),
    reposRetryPreparation: vi.fn(async () => ({})),
    reposPickFolder: vi.fn(async () => ({ status: 'cancelled' })),
    reposRemove: vi.fn(async () => ({ status: 'removed' })),
    sessionsList: vi.fn(async () => ({ sessions: [], orphans: [] })),
    sessionsGet: vi.fn(async () => ({})),
    sessionsCreate: vi.fn(async () => ({})),
    sessionsClose: vi.fn(async () => null),
    sessionsRestart: vi.fn(async () => ({})),
    sessionsSleep: vi.fn(async () => ({})),
    sessionsWake: vi.fn(async () => ({})),
    sessionsRemove: vi.fn(async () => ({ status: 'removed', branch: null, branchRetained: false })),
    sessionsDiscard: vi.fn(async () => ({ status: 'discarded' })),
    sessionsRecoverWorktree: vi.fn(async () => ({})),
    branchesList: vi.fn(async () => []),
    branchesRemove: vi.fn(async () => ({ status: 'removed' })),
    activityList: vi.fn(async () => []),
    activityClearUnread: vi.fn(async () => true),
    filesList: vi.fn(async () => ({ status: 'ok', path: '', entries: [], truncated: false })),
    filesRead: vi.fn(async () => ({ status: 'ok', path: 'a', text: '', size: 0, binary: false, tooLarge: false, missingTrailingNewline: false })),
    filesWrite: vi.fn(async () => ({ status: 'ok', size: 1 })),
    filesSearch: vi.fn(async () => ({ status: 'ok', matches: [], truncated: false, scannedFiles: 0 })),
    filesCancelSearch: vi.fn(async () => ({ cancelled: true })),
    filesReplace: vi.fn(async () => ({
      status: 'ok',
      files: 0,
      replacements: 0,
      results: [],
      truncated: false
    })),
    filesCreate: vi.fn(async () => ({ status: 'ok', path: 'a' })),
    filesRename: vi.fn(async () => ({ status: 'ok', from: 'a', to: 'b' })),
    filesRemove: vi.fn(async () => ({ status: 'ok', path: 'a' })),
    gitInvoke: vi.fn(async () => ({ status: 'ok' })),
    filesRemoveMany: vi.fn(async () => ({ status: 'ok', results: [] })),
    filesMoveMany: vi.fn(async () => ({ status: 'ok', results: [] })),
    filesCopyMany: vi.fn(async () => ({ status: 'ok', results: [] })),
    filesCopyPaths: vi.fn(async () => ({ status: 'ok', count: 1 })),
    filesStat: vi.fn(async () => ({
      status: 'ok',
      path: 'a',
      kind: 'file',
      size: 0,
      etag: '0:0',
      modifiedAt: 0
    })),
    filesTrash: vi.fn(async () => ({ status: 'ok', opId: null, results: [], entries: [] })),
    filesRestoreTrash: vi.fn(async () => ({ status: 'ok', results: [] })),
    filesListTrash: vi.fn(async () => ({ status: 'ok', items: [] })),
    filesWatch: vi.fn(async () => ({ watching: true })),
    tasksList: vi.fn(async () => []),
    tasksCreate: vi.fn(async () => ({ id: 'task_1', status: 'queued' })),
    tasksCancel: vi.fn(async () => ({ id: 'task_1', status: 'cancelled' })),
    tasksRetry: vi.fn(async () => ({ id: 'task_2', status: 'queued' })),
    tasksHistory: vi.fn(async () => []),
    tasksChanges: vi.fn(async () => ({ status: 'available', files: [] })),
    tasksDecideReview: vi.fn(async () => ({ id: 'task_1', reviewDecision: 'accepted' })),
    tasksSettings: vi.fn(async () => ({ maxConcurrent: 1 })),
    tasksSetSettings: vi.fn(async () => 2),
    schedulesList: vi.fn(async () => []),
    schedulesCreate: vi.fn(async () => ({ id: 'sch_1' })),
    schedulesUpdate: vi.fn(async () => ({ id: 'sch_1' })),
    schedulesSetEnabled: vi.fn(async () => ({ id: 'sch_1', enabled: false })),
    schedulesRunNow: vi.fn(async () => ({ result: 'created', taskId: 'task_1', occurrenceAt: 1, trigger: 'manual' })),
    schedulesRemove: vi.fn(async () => undefined),
    harnessList: vi.fn(async () => []),
    wslListDistros: vi.fn(async () => ({ status: 'ok', distros: [], defaultRegistrationId: null })),
    terminalAttach: vi.fn(async () => ({})),
    terminalWrite: vi.fn(async () => null),
    terminalResize: vi.fn(async () => null),
    ...overrides
  }
}

const repoId = newRepoId()
const sessionId = newSessionId()
const incarnationId = 'abcdef1234567890'

describe('dispatcher validation', () => {
  it('rejects an unknown channel', async () => {
    const dispatch = createDispatcher(services())
    const result = await dispatch('icode:exec', { command: 'rm -rf /' })
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  })

  it('rejects a relative repository path before calling the service', async () => {
    const repoAdd = vi.fn(async () => ({}))
    const dispatch = createDispatcher(services({ reposAdd: repoAdd }))
    const result = await dispatch(IPC_CHANNELS.reposAdd, { path: 'relative/repo' })
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(repoAdd).not.toHaveBeenCalled()
  })

  it('validates and routes project inspection and initialization', async () => {
    const inspect = vi.fn(async () => ({ kind: 'gitless' }))
    const initialize = vi.fn(async () => ({ initialized: true }))
    const dispatch = createDispatcher(
      services({ reposInspect: inspect, reposInitialize: initialize })
    )
    const target = { kind: 'local' as const }

    expect(
      await dispatch(IPC_CHANNELS.reposInspect, { path: 'relative/project', target })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(inspect).not.toHaveBeenCalled()

    expect(
      await dispatch(IPC_CHANNELS.reposInspect, { path: '/tmp/project', target })
    ).toMatchObject({ ok: true })
    expect(inspect).toHaveBeenCalledWith({ path: '/tmp/project', target })

    expect(
      await dispatch(IPC_CHANNELS.reposInitialize, {
        path: '/tmp/project',
        target,
        identity: { name: 'Project Test', email: 'project@test.local' }
      })
    ).toMatchObject({ ok: true })
    expect(initialize).toHaveBeenCalledWith({
      path: '/tmp/project',
      target,
      identity: { name: 'Project Test', email: 'project@test.local' }
    })
  })

  it('routes a WSL Windows-drive browse source to the picker', async () => {
    const pick = vi.fn(async () => ({ status: 'cancelled' }))
    const dispatch = createDispatcher(services({ reposPickFolder: pick }))
    const target = { kind: 'wsl' as const, distro: 'Ubuntu-26.04', distroId: 'reg-1' }

    expect(
      await dispatch(IPC_CHANNELS.reposPickFolder, { target, source: 'windows' })
    ).toMatchObject({ ok: true })
    expect(pick).toHaveBeenCalledWith({ target, source: 'windows' })

    expect(
      await dispatch(IPC_CHANNELS.reposPickFolder, { target, source: 'network' })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(pick).toHaveBeenCalledTimes(1)
  })

  it('carries a rejected WSL target to the renderer as its own code, not INTERNAL', async () => {
    // The dispatcher has no WSL branch: the target error rides the existing
    // `appError` contract, so a future error code needs no dispatcher change.
    const repoAdd = vi.fn(async () => {
      throw new RepositoryTargetError(
        makeAppError('WSL_DISTRO_NOT_FOUND', 'The WSL distro "Ubuntu-99.99" is gone.')
      )
    })
    const dispatch = createDispatcher(services({ reposAdd: repoAdd }))
    const result = await dispatch(IPC_CHANNELS.reposAdd, {
      path: '/home/user/project',
      target: { kind: 'wsl', distro: 'Ubuntu-99.99', distroId: null }
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'WSL_DISTRO_NOT_FOUND', retryable: false }
    })
  })

  it('rejects unknown fields and malformed IDs', async () => {
    const dispatch = createDispatcher(services())
    expect(
      await dispatch(IPC_CHANNELS.reposAdd, { path: '/tmp/repo', command: 'bash' })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(
      await dispatch(IPC_CHANNELS.reposRemove, { repoId: sessionId })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  })

  it('rejects an unsupported harness and bad dimensions', async () => {
    const create = vi.fn(async () => ({}))
    const dispatch = createDispatcher(services({ sessionsCreate: create }))
    expect(
      await dispatch(IPC_CHANNELS.sessionsCreate, {
        repoId,
        harness: 'gemini',
        cols: 100,
        rows: 30
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(
      await dispatch(IPC_CHANNELS.sessionsCreate, {
        repoId,
        harness: 'claude',
        cols: 0,
        rows: 30
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(create).not.toHaveBeenCalled()
  })

  it('requires the incarnation on terminal writes', async () => {
    const write = vi.fn(async () => null)
    const dispatch = createDispatcher(services({ terminalWrite: write }))
    expect(
      await dispatch(IPC_CHANNELS.terminalWrite, { sessionId, data: 'ls\r' })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(
      await dispatch(IPC_CHANNELS.terminalWrite, { sessionId, incarnationId, data: 'ls\r' })
    ).toEqual({ ok: true, value: null })
    expect(write).toHaveBeenCalledWith({ sessionId, incarnationId, data: 'ls\r' })
  })

  it('rejects oversized terminal input', async () => {
    const dispatch = createDispatcher(services())
    const result = await dispatch(IPC_CHANNELS.terminalWrite, {
      sessionId,
      incarnationId,
      data: 'x'.repeat(1_048_577)
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  })

  it('rejects extra fields in list sessions input', async () => {
    const dispatch = createDispatcher(services())
    expect(
      await dispatch(IPC_CHANNELS.sessionsList, { repoId, includeOrphans: true })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  })
})

describe('dispatcher results', () => {
  it('routes activity snapshots and validates unread clearing', async () => {
    const activityList = vi.fn(async () => [{ sessionId, activity: { state: 'idle' } }])
    const activityClearUnread = vi.fn(async () => true)
    const dispatch = createDispatcher(services({ activityList, activityClearUnread }))
    const sessionId = newSessionId()

    expect(await dispatch(IPC_CHANNELS.activityList)).toEqual({
      ok: true,
      value: [{ sessionId, activity: { state: 'idle' } }]
    })
    expect(await dispatch(IPC_CHANNELS.activityClearUnread, { sessionId })).toEqual({
      ok: true,
      value: true
    })
    expect(activityClearUnread).toHaveBeenCalledWith({ sessionId })

    for (const bad of [{}, { sessionId, unread: false }, { sessionId: '' }]) {
      expect((await dispatch(IPC_CHANNELS.activityClearUnread, bad)).ok).toBe(false)
    }
    expect(activityClearUnread).toHaveBeenCalledTimes(1)
  })

  it('forwards a Git command envelope to the registry', async () => {
    const service = services()
    const dispatch = createDispatcher(service)
    const envelope = { op: 'changeDiff', input: { sessionId: newSessionId() } }

    expect(await dispatch(IPC_CHANNELS.gitInvoke, envelope)).toMatchObject({ ok: true })
    expect(service.gitInvoke).toHaveBeenCalledWith(envelope)
  })

  it('wraps success values', async () => {
    const dispatch = createDispatcher(services({ reposList: async () => [{ id: repoId }] }))
    expect(await dispatch(IPC_CHANNELS.reposList)).toEqual({
      ok: true,
      value: [{ id: repoId }]
    })
  })

  it('maps service errors to stable app errors', async () => {
    const dispatch = createDispatcher(
      services({
        terminalAttach: async () => {
          throw new SessionServiceError(
            makeAppError('SESSION_NOT_FOUND', 'The host no longer owns this session.', {
              detail: 'gone',
              context: { sessionId }
            })
          )
        }
      })
    )
    expect(await dispatch(IPC_CHANNELS.terminalAttach, { sessionId })).toEqual({
      ok: false,
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'The host no longer owns this session.',
        detail: 'gone',
        retryable: false,
        context: { sessionId }
      }
    })
  })

  it('passes database errors through without inventing a retry policy', async () => {
    const dispatch = createDispatcher(
      services({
        reposList: async () => {
          throw new DatabaseError(makeAppError('DB_CORRUPT', 'The database is damaged.'))
        }
      })
    )
    expect(await dispatch(IPC_CHANNELS.reposList)).toMatchObject({
      ok: false,
      error: { code: 'DB_CORRUPT', retryable: false }
    })
  })

  it('converts unexpected errors to INTERNAL without leaking stack traces', async () => {
    const dispatch = createDispatcher(
      services({
        harnessList: async () => {
          throw new Error('boom at /secret/path')
        }
      })
    )
    const result = await dispatch(IPC_CHANNELS.harnessList, {})
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    if (result.ok) return
    expect(result.error.message).toBe('Unexpected application error.')
    expect(result.error.detail).toContain('boom')
  })

  it('returns a structured result for repository removal confirmation', async () => {
    const dispatch = createDispatcher(
      services({
        reposRemove: async () => ({
          status: 'confirmation_required',
          sessions: []
        })
      })
    )
    expect(await dispatch(IPC_CHANNELS.reposRemove, { repoId })).toEqual({
      ok: true,
      value: { status: 'confirmation_required', sessions: [] }
    })
  })
})

/**
 * W9: detection is per execution target, so the renderer must be able to say
 * *which* repository it is asking about. The distro list is a separate, input-free
 * question because discovery is machine-wide.
 */
describe('execution-target aware IPC', () => {
  it('passes repoId through to Harness detection', async () => {
    const harnessList = vi.fn(async () => [])
    const dispatch = createDispatcher(services({ harnessList }))
    const result = await dispatch(IPC_CHANNELS.harnessList, { repoId })
    expect(result).toMatchObject({ ok: true })
    expect(harnessList).toHaveBeenCalledWith({ repoId })
  })

  it('keeps the pre-W9 call shape when no repository is named', async () => {
    const harnessList = vi.fn(async () => [])
    const dispatch = createDispatcher(services({ harnessList }))
    await dispatch(IPC_CHANNELS.harnessList, {})
    expect(harnessList).toHaveBeenCalledWith({})
  })

  it('rejects a malformed repoId instead of detecting for the wrong target', async () => {
    const harnessList = vi.fn(async () => [])
    const dispatch = createDispatcher(services({ harnessList }))
    const result = await dispatch(IPC_CHANNELS.harnessList, { repoId: 'not-a-repo-id' })
    expect(result).toMatchObject({ ok: false })
    expect(harnessList).not.toHaveBeenCalled()
  })

  it('serves the distro list on its own channel', async () => {
    const wslListDistros = vi.fn(async () => ({
      status: 'ok' as const,
      distros: [{ name: 'Ubuntu-26.04', registrationId: 'abc', version: 2 as const, running: true }],
      defaultRegistrationId: 'abc'
    }))
    const dispatch = createDispatcher(services({ wslListDistros }))
    const result = await dispatch(IPC_CHANNELS.wslListDistros)
    expect(result).toMatchObject({ ok: true, value: { status: 'ok' } })
    expect(wslListDistros).toHaveBeenCalledTimes(1)
  })

  it('returns "unavailable" as a value, not as an IPC error', async () => {
    const dispatch = createDispatcher(
      services({
        wslListDistros: async () => ({
          status: 'unavailable' as const,
          reason: 'not_windows' as const,
          detail: 'WSL is Windows only'
        })
      })
    )
    const result = await dispatch(IPC_CHANNELS.wslListDistros)
    // Not an error: the dialog must still be able to offer local repositories.
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'unavailable', reason: 'not_windows' }
    })
  })

  it('passes Git envelopes through and lets the registry validate them', async () => {
    const service = services()
    const dispatch = createDispatcher(service)
    const envelope = {
      op: 'setPathsStaged',
      input: { sessionId, targets: [{ path: 'src/a.ts', area: 'unstaged' }], staged: true }
    }

    expect(await dispatch(IPC_CHANNELS.gitInvoke, envelope)).toMatchObject({ ok: true })
    expect(service.gitInvoke).toHaveBeenCalledWith(envelope)
  })
})
