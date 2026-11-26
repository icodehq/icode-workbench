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
    sidebarOrderGet: vi.fn(async () => ({ projects: [], worktrees: {}, sessions: {} })),
    sidebarOrderSet: vi.fn(async (input) => input),
    reposList: vi.fn(async () => []),
    reposAdd: vi.fn(async () => ({})),
    reposInspect: vi.fn(async () => ({})),
    reposInitialize: vi.fn(async () => ({})),
    reposRetryPreparation: vi.fn(async () => ({})),
    reposPickFolder: vi.fn(async () => ({ status: 'cancelled' })),
    reposRemove: vi.fn(async () => ({ status: 'removing', jobId: 'job-1' })),
    reposRemovalJobsList: vi.fn(async () => ({ jobs: [] })),
    reposRemovalJobRetry: vi.fn(async () => ({ status: 'retrying' })),
    reposRemovalJobDiscardSnapshots: vi.fn(async () => ({ discarded: 0 })),
    sessionsList: vi.fn(async () => ({ sessions: [], orphans: [] })),
    sessionsGet: vi.fn(async () => ({})),
    sessionsCreate: vi.fn(async () => ({})),
    sessionsClose: vi.fn(async () => null),
    sessionsRestart: vi.fn(async () => ({})),
    sessionsResume: vi.fn(async () => ({})),
    sessionsSleep: vi.fn(async () => ({})),
    sessionsWake: vi.fn(async () => ({})),
    sessionsRemove: vi.fn(async () => ({ status: 'removed', branch: null, branchRetained: false })),
    sessionsDiscard: vi.fn(async () => ({ status: 'discarded' })),
    sessionsRecoverWorktree: vi.fn(async () => ({})),
    worktreesRemove: vi.fn(async () => ({ status: 'removed', sessionIds: [], branch: null, branchRetained: false })),
    worktreesDiscard: vi.fn(async () => ({ status: 'discarded', sessionIds: [] })),
    branchesList: vi.fn(async () => []),
    branchesRefs: vi.fn(async () => []),
    branchesCurrent: vi.fn(async () => null),
    branchesRemove: vi.fn(async () => ({ status: 'removed' })),
    remotesList: vi.fn(async () => []),
    remotesAdd: vi.fn(async () => ({ status: 'ok', name: 'origin' })),
    remotesSetUrl: vi.fn(async () => ({ status: 'ok', name: 'origin' })),
    remotesRemove: vi.fn(async () => ({ status: 'ok', name: 'origin' })),
    remotesFetch: vi.fn(async () => ({ status: 'ok', name: 'origin' })),
    cloneStart: vi.fn(async () => ({ requestId: 'clone-1' })),
    cloneCancel: vi.fn(async () => ({ cancelled: true })),
    clonePersist: vi.fn(async () => ({ status: 'skipped' })),
    cloneSshStatus: vi.fn(async () => ({ sshAvailable: false })),
    cloneSshGenerate: vi.fn(async () => ({ status: 'exists' })),
    cloneSshTest: vi.fn(async () => ({ status: 'ok' })),
    cloneSshTrustHost: vi.fn(async () => ({ status: 'trusted' })),
    mergeStart: vi.fn(async () => ({ status: 'merged', record: {} })),
    mergeContinue: vi.fn(async () => ({ status: 'merged', record: {} })),
    mergeAbort: vi.fn(async () => ({})),
    mergeState: vi.fn(async () => null),
    activityList: vi.fn(async () => []),
    activityClearUnread: vi.fn(async () => true),
    opencodeIntegrationGet: vi.fn(async () => ({
      enabled: true,
      api: 'unknown',
      install: { state: 'not-installed', configDir: '/home/dev/.config/opencode' }
    })),
    opencodeIntegrationSetEnabled: vi.fn(async () => ({
      enabled: true,
      api: 'unknown',
      install: { state: 'not-installed', configDir: '/home/dev/.config/opencode' }
    })),
    managedHooksGet: vi.fn(async () => ({ enabled: true, providers: [] })),
    managedHooksSetEnabled: vi.fn(async () => ({ enabled: true, providers: [] })),
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
    tasksApprove: vi.fn(async () => ({ id: 'task_1', status: 'queued' })),
    tasksReject: vi.fn(async () => ({ id: 'task_1', status: 'cancelled' })),
    tasksCancel: vi.fn(async () => ({ id: 'task_1', status: 'cancelled' })),
    tasksRetry: vi.fn(async () => ({ id: 'task_2', status: 'queued' })),
    tasksResume: vi.fn(async () => ({ id: 'task_3', status: 'queued' })),
    tasksHistory: vi.fn(async () => []),
    tasksChanges: vi.fn(async () => ({ status: 'available', files: [] })),
    tasksDecideReview: vi.fn(async () => ({ id: 'task_1', reviewDecision: 'accepted' })),
    tasksRequestChanges: vi.fn(async () => ({ id: 'task_2', attempt: 2 })),
    tasksArchive: vi.fn(async () => ({ id: 'task_1', archivedAt: 1 })),
    tasksUnarchive: vi.fn(async () => ({ id: 'task_1', archivedAt: null })),
    tasksArchiveFinished: vi.fn(async () => 0),
    tasksAddDependency: vi.fn(async () => ({ id: 'task_1', status: 'queued' })),
    tasksRemoveDependency: vi.fn(async () => ({ id: 'task_1', status: 'queued' })),
    tasksSetHoldDependents: vi.fn(async () => ({ id: 'task_1', status: 'queued' })),
    tasksSettings: vi.fn(async () => ({ maxConcurrent: 1, maxConcurrentPerProject: 1 })),
    tasksSetSettings: vi.fn(async () => ({ maxConcurrent: 2, maxConcurrentPerProject: 1 })),
    supervisorOpen: vi.fn(async () => ({ id: 'ses_supervisor' })),
    botsList: vi.fn(async () => []),
    botsCreate: vi.fn(async () => ({ id: 'bot_1' })),
    botsUpdate: vi.fn(async () => ({ id: 'bot_1' })),
    botsArchive: vi.fn(async () => true),
    botsSetPaused: vi.fn(async () => ({ id: 'bot_1' })),
    botsState: vi.fn(async () => ({ threadId: 'thread_1', unread: 0 })),
    botsMessages: vi.fn(async () => []),
    botsConversations: vi.fn(async () => []),
    botsNotifications: vi.fn(async () => []),
    botsSend: vi.fn(async () => ({ message: { id: 'msg_1' }, runId: 'run_1' })),
    botsMarkRead: vi.fn(async () => 0),
    botsStop: vi.fn(async () => null),
    botsNewConversation: vi.fn(async () => ({ message: null })),
    botsFocus: vi.fn(async () => null),
    botsSettingsGet: vi.fn(async () => ({ personaName: 'Backend' })),
    botsSettingsSet: vi.fn(async () => ({ personaName: 'Backend' })),
    botsMemoryList: vi.fn(async () => []),
    botsMemorySet: vi.fn(async () => ({ id: 'mem_1' })),
    botsMemoryDelete: vi.fn(async () => true),
    botsMemoryApprove: vi.fn(async () => ({ id: 'mem_1' })),
    groupsList: vi.fn(async () => []),
    groupsCreate: vi.fn(async () => ({ id: 'group_1' })),
    groupsUpdate: vi.fn(async () => ({ id: 'group_1' })),
    groupsArchive: vi.fn(async () => ({ id: 'group_1' })),
    groupsDelete: vi.fn(async () => true),
    groupsThreads: vi.fn(async () => []),
    groupsThreadCreate: vi.fn(async () => ({ thread: { id: 'gthread_1' } })),
    groupsMessages: vi.fn(async () => ({ messages: [], hasEarlier: false })),
    groupsSend: vi.fn(async () => ({ message: { id: 'gmsg_1' } })),
    groupsMarkRead: vi.fn(async () => ({ unread: 0 })),
    groupsSetRead: vi.fn(async () => ({ unread: 0 })),
    groupsSetMuted: vi.fn(async () => ({ group: { id: 'group_1' } })),
    groupsStop: vi.fn(async () => ({ turns: [] })),
    itemsList: vi.fn(async () => ({ items: [], counts: { planned: 0, working: 0, waiting: 0, needs_you: 0, done: 0, canceled: 0 } })),
    itemsGet: vi.fn(async () => ({ item: null })),
    itemsComment: vi.fn(async () => ({ id: 'comment_1' })),
    itemsAsk: vi.fn(async () => ({ id: 'question_1' })),
    itemsAnswer: vi.fn(async () => ({ question: { id: 'question_1' }, answer: { id: 'answer_1' } })),
    itemsSnooze: vi.fn(async () => ({ item: null })),
    itemsSetStatus: vi.fn(async () => ({ item: null })),
    itemsLinkAdd: vi.fn(async () => ({ taskId: 'task_1', kind: 'url', ref: 'https://example.com' })),
    itemsLinkRemove: vi.fn(async () => true),
    itemsAttach: vi.fn(async () => ({ id: 'attachment_1' })),
    itemsRemoveAttachment: vi.fn(async () => true),
    networkSettingsGet: vi.fn(async () => ({
      mode: 'system',
      httpProxyUrl: '',
      httpsProxyUrl: '',
      noProxy: ''
    })),
    networkSetSettings: vi.fn(async () => ({
      mode: 'system',
      httpProxyUrl: '',
      httpsProxyUrl: '',
      noProxy: ''
    })),
    updatesGet: vi.fn(async () => ({})),
    updatesCheck: vi.fn(async () => ({})),
    updatesDownload: vi.fn(async () => ({})),
    updatesCancelDownload: vi.fn(async () => ({})),
    updatesInstall: vi.fn(async () => ({ status: 'blocked' })),
    updatesSkip: vi.fn(async () => ({})),
    updatesSetAutoCheck: vi.fn(async () => ({})),
    schedulesList: vi.fn(async () => []),
    schedulesCreate: vi.fn(async () => ({ id: 'sch_1' })),
    schedulesUpdate: vi.fn(async () => ({ id: 'sch_1' })),
    schedulesSetEnabled: vi.fn(async () => ({ id: 'sch_1', enabled: false })),
    schedulesRunNow: vi.fn(async () => ({ result: 'created', taskId: 'task_1', occurrenceAt: 1, trigger: 'manual' })),
    schedulesRemove: vi.fn(async () => undefined),
    harnessList: vi.fn(async () => []),
    providersList: vi.fn(async () => ({
      providers: [],
      selections: [],
      secretStorage: { backend: 'safe_storage', secure: true }
    })),
    providersCreate: vi.fn(async () => ({})),
    providersUpdate: vi.fn(async () => ({})),
    providersRemove: vi.fn(async () => null),
    providersSelect: vi.fn(async () => null),
    providersTest: vi.fn(async () => ({
      ok: true,
      code: 'ok',
      status: 200,
      latencyMs: 1,
      message: 'ok'
    })),
    aiCommitMessage: vi.fn(async () => ({ status: 'ok', message: 'test', agent: 'claude' })),
    aiCancelCommitMessage: vi.fn(async () => ({ cancelled: true })),
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

  it('validates and routes AI commit-message generation', async () => {
    const generate = vi.fn(async () => ({
      status: 'ok' as const,
      message: 'feat: generated',
      agent: 'claude' as const
    }))
    const cancel = vi.fn(async () => ({ cancelled: true }))
    const dispatch = createDispatcher(
      services({ aiCommitMessage: generate, aiCancelCommitMessage: cancel })
    )

    expect(
      await dispatch(IPC_CHANNELS.aiCommitMessage, { sessionId: 'not-a-session', requestId: 'x' })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(generate).not.toHaveBeenCalled()

    expect(
      await dispatch(IPC_CHANNELS.aiCommitMessage, { sessionId, requestId: 'request-123' })
    ).toMatchObject({ ok: true })
    expect(generate).toHaveBeenCalledWith({ sessionId, requestId: 'request-123' })

    expect(
      await dispatch(IPC_CHANNELS.aiCancelCommitMessage, { requestId: 'request-123' })
    ).toMatchObject({ ok: true, value: { cancelled: true } })
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
        harness: 'not-a-harness',
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

  it('forwards the default checkout mode to the session service', async () => {
    const create = vi.fn(async () => ({}))
    const dispatch = createDispatcher(services({ sessionsCreate: create }))
    const input = { repoId, harness: 'shell', cols: 100, rows: 30, checkout: 'default' }
    expect(await dispatch(IPC_CHANNELS.sessionsCreate, input)).toMatchObject({ ok: true })
    expect(create).toHaveBeenCalledWith(input)
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

  it('returns the durable removal job id immediately', async () => {
    const dispatch = createDispatcher(
      services({
        reposRemove: async () => ({ status: 'removing', jobId: 'job-1' })
      })
    )
    expect(await dispatch(IPC_CHANNELS.reposRemove, { repoId })).toEqual({
      ok: true,
      value: { status: 'removing', jobId: 'job-1' }
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

  it('routes and validates network settings', async () => {
    const get = vi.fn(async () => ({
      mode: 'system',
      httpProxyUrl: '',
      httpsProxyUrl: '',
      noProxy: ''
    }))
    const set = vi.fn(async (_input: { settings: unknown }) => ({
      mode: 'system',
      httpProxyUrl: '',
      httpsProxyUrl: '',
      noProxy: ''
    }))
    const dispatch = createDispatcher(
      services({ networkSettingsGet: get, networkSetSettings: set })
    )

    expect(await dispatch(IPC_CHANNELS.networkSettingsGet, {})).toMatchObject({ ok: true })
    const settings = {
      mode: 'manual',
      httpProxyUrl: 'http://127.0.0.1:7890',
      httpsProxyUrl: '',
      noProxy: ''
    }
    expect(
      await dispatch(IPC_CHANNELS.networkSetSettings, { settings })
    ).toMatchObject({ ok: true })
    expect(set).toHaveBeenCalledWith({ settings })

    const invalid = await dispatch(IPC_CHANNELS.networkSetSettings, {
      settings: {
        mode: 'manual',
        httpProxyUrl: 'http://host',
        httpsProxyUrl: '',
        noProxy: ''
      }
    })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('validates provider update and test requests', async () => {
    const update = vi.fn(async (input: { id: string }) => ({ id: input.id }))
    const test = vi.fn(async (_input: { providerId: string }) => ({
      ok: true,
      code: 'ok',
      status: 200,
      latencyMs: 1,
      message: 'ok'
    }))
    const dispatch = createDispatcher(
      services({ providersUpdate: update, providersTest: test })
    )
    const providerId = 'prv_00000000-0000-4000-8000-000000000001'

    expect(
      await dispatch(IPC_CHANNELS.providersUpdate, {
        id: providerId,
        harness: 'claude',
        name: 'Relay',
        baseUrl: 'https://relay.example.com',
        model: 'claude-sonnet-5'
      })
    ).toMatchObject({ ok: true })
    expect(update).toHaveBeenCalledWith({
      id: providerId,
      harness: 'claude',
      name: 'Relay',
      baseUrl: 'https://relay.example.com',
      model: 'claude-sonnet-5'
    })

    expect(await dispatch(IPC_CHANNELS.providersTest, { providerId })).toMatchObject({
      ok: true
    })
    expect(test).toHaveBeenCalledWith({ providerId })

    expect(await dispatch(IPC_CHANNELS.providersUpdate, { id: 'bad' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' }
    })
  })
})

describe('remote and clone IPC', () => {
  it('validates and routes remote mutations', async () => {
    const service = services()
    const dispatch = createDispatcher(service)
    const id = newRepoId()

    expect(await dispatch(IPC_CHANNELS.remotesList, { repoId: id })).toMatchObject({ ok: true })
    expect(await dispatch(IPC_CHANNELS.remotesAdd, {
      repoId: id,
      name: 'origin',
      url: 'https://github.com/o/r.git'
    })).toMatchObject({ ok: true })
    expect(await dispatch(IPC_CHANNELS.remotesSetUrl, {
      repoId: id,
      name: 'origin',
      url: 'https://github.com/o/r2.git'
    })).toMatchObject({ ok: true })
    expect(await dispatch(IPC_CHANNELS.remotesRemove, { repoId: id, name: 'origin' })).toMatchObject({
      ok: true
    })
    expect(await dispatch(IPC_CHANNELS.remotesFetch, {
      repoId: id,
      name: 'origin',
      prune: true
    })).toMatchObject({ ok: true })
    expect(service.remotesFetch).toHaveBeenCalledWith({
      repoId: id,
      name: 'origin',
      prune: true
    })

    expect(await dispatch(IPC_CHANNELS.remotesAdd, {
      repoId: id,
      name: 'origin',
      url: 'ext::sh -c calc'
    })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(await dispatch(IPC_CHANNELS.remotesList, { repoId: 'bad' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' }
    })
  })

  it('validates clone start and routes cancellation', async () => {
    const service = services()
    const dispatch = createDispatcher(service)
    const input = {
      requestId: 'clone-1',
      url: 'https://github.com/o/r.git',
      target: { kind: 'local' as const },
      parentPath: '/projects',
      name: 'repo'
    }
    expect(await dispatch(IPC_CHANNELS.cloneStart, input)).toMatchObject({ ok: true })
    expect(service.cloneStart).toHaveBeenCalledWith(input)
    expect(await dispatch(IPC_CHANNELS.cloneCancel, { requestId: 'clone-1' })).toMatchObject({
      ok: true
    })

    expect(await dispatch(IPC_CHANNELS.cloneStart, { ...input, requestId: 'bad id' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' }
    })
    expect(await dispatch(IPC_CHANNELS.cloneStart, { ...input, parentPath: 'relative' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' }
    })
    expect(await dispatch(IPC_CHANNELS.cloneStart, { ...input, url: 'ext::sh -c calc' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' }
    })
  })

  it('validates the interactive auth, persistence and SSH payloads', async () => {
    const service = services()
    const dispatch = createDispatcher(service)
    const input = {
      requestId: 'clone-1',
      url: 'https://github.com/o/r.git',
      target: { kind: 'local' as const },
      parentPath: '/projects',
      name: 'repo'
    }
    const auth = { kind: 'https' as const, username: 'alice', password: 'token' }
    expect(await dispatch(IPC_CHANNELS.cloneStart, { ...input, auth })).toMatchObject({
      ok: true
    })
    expect(service.cloneStart).toHaveBeenLastCalledWith({ ...input, auth })
    expect(
      await dispatch(IPC_CHANNELS.cloneStart, {
        ...input,
        auth: { kind: 'https', username: 'alice', password: 'line\nbreak' }
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })

    expect(
      await dispatch(IPC_CHANNELS.clonePersist, { requestId: 'clone-1', mode: 'skip' })
    ).toMatchObject({ ok: true })
    expect(
      await dispatch(IPC_CHANNELS.clonePersist, { requestId: 'clone-1', mode: 'nope' })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })

    expect(
      await dispatch(IPC_CHANNELS.cloneSshGenerate, {
        target: { kind: 'local' },
        consent: false
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(
      await dispatch(IPC_CHANNELS.cloneSshTrustHost, {
        target: { kind: 'local' },
        host: 'gitee.com',
        port: 22,
        fingerprints: ['SHA256:abc123']
      })
    ).toMatchObject({ ok: true })
    expect(
      await dispatch(IPC_CHANNELS.cloneSshTrustHost, {
        target: { kind: 'local' },
        host: 'gitee.com',
        port: 22,
        fingerprints: ['not-a-fingerprint']
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  })
})

describe('sidebar order dispatch', () => {
  it('routes and validates the persisted order document', async () => {
    const get = vi.fn(async () => ({ projects: [], worktrees: {}, sessions: {} }))
    const set = vi.fn(async (input) => input)
    const dispatch = createDispatcher(services({ sidebarOrderGet: get, sidebarOrderSet: set }))

    expect(await dispatch(IPC_CHANNELS.sidebarOrderGet, {})).toMatchObject({ ok: true })
    expect(get).toHaveBeenCalled()

    const order = {
      projects: ['repo_1'],
      worktrees: { repo_1: ['/tmp/wt'] },
      sessions: { 'worktree:/tmp/wt': ['ses_1'] }
    }
    expect(await dispatch(IPC_CHANNELS.sidebarOrderSet, order)).toMatchObject({ ok: true })
    expect(set).toHaveBeenCalledWith(order)

    const invalid = await dispatch(IPC_CHANNELS.sidebarOrderSet, {
      projects: 'nope'
    })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(set).toHaveBeenCalledTimes(1)
  })
})
