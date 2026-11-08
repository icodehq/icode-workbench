import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionSummary } from '../../shared/schemas/ipc'
import { AGENT_PASTE_START } from '../../shared/agent-prompt'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import { SupervisorStore } from '../persistence/supervisor-store'
import { TaskStore } from '../tasks/task-store'
import { TaskService } from '../tasks/task-service'
import type { SupervisorControlRequest } from './control-server'
import {
  makeRepositoryService,
  makeTempRoot,
  openTempDatabase
} from '../persistence/persistence-test-fixtures'
import { SupervisorService } from './supervisor-service'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe('SupervisorService', () => {
  it('creates one role-supervisor session, writes its control files, and bootstraps it once', async () => {
    const root = makeTempRoot('icode-supervisor-service-')
    const db = openTempDatabase(root)
    const stores = makeRepositoryService(db)
    const repoDir = join(root.dir, 'repo')
    mkdirSync(repoDir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'pipe' })
    writeFileSync(join(repoDir, 'README.md'), 'base\n')
    execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' })
    execFileSync(
      'git',
      ['-C', repoDir, '-c', 'user.email=sup@test', '-c', 'user.name=Sup', 'commit', '-qm', 'base'],
      { stdio: 'pipe' }
    )
    const added = await stores.service.addRepository(repoDir)

    const writes: Array<{ sessionId: string; data: string }> = []
    let created = 0
    const sessions = {
      create: async (input: { repoId: string; harness: string }, options?: { role?: string }) => {
        created += 1
        return summary(input.repoId, input.harness, options?.role ?? 'interactive')
      },
      get: async () => summary(added.repository.id, 'claude', 'supervisor'),
      write: async (sessionId: string, _incarnation: string, data: string) => {
        writes.push({ sessionId, data })
      },
      restart: async () => summary(added.repository.id, 'claude', 'supervisor'),
      wake: async () => summary(added.repository.id, 'claude', 'supervisor')
    }
    const service = new SupervisorService({
      userDataDir: root.dir,
      execPath: process.execPath,
      platform: process.platform,
      now: () => 1_700_000_000_000,
      store: new SupervisorStore(db),
      sessions: sessions as never,
      tasks: {} as never,
      taskStore: {} as never,
      repositories: stores.repositories,
      gitWorkspace: {} as never,
      workspaceFiles: {} as never,
      bootstrapDelayMs: 0,
      listHarnesses: async () =>
        [{ harness: 'claude', state: 'available' } as HarnessDetectionResult]
    })
    await service.start()
    cleanups.push(async () => {
      await service.stop()
      db.close()
      root.cleanup()
    })

    const first = await service.open(added.repository.id as never)
    expect(created).toBe(1)
    expect(first.role).toBe('supervisor')
    const paste = writes.find((entry) => entry.data.includes(AGENT_PASTE_START))
    expect(paste?.data).toContain('iCode Supervisor')
    // The paste must use CR line breaks, and the Enter must be a separate write.
    expect(paste?.data.includes('\n')).toBe(false)
    expect(writes.some((entry) => entry.data === '\r')).toBe(true)

    const binding = new SupervisorStore(db).findByRepo(added.repository.id as never)!
    const configPath = join(root.dir, 'supervisor', 'projects', added.repository.id, 'control.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      repoId: string
      token: string
    }
    expect(config.repoId).toBe(added.repository.id)
    expect(config.token).toBe(binding.controlToken)

    const second = await service.open(added.repository.id as never)
    expect(second.id).toBe(first.id)
    expect(created).toBe(1)
  })

  it('reuses a live binding without sending the bootstrap again', async () => {
    const root = makeTempRoot('icode-supervisor-service-')
    const db = openTempDatabase(root)
    const stores = makeRepositoryService(db)
    const repoDir = join(root.dir, 'repo')
    mkdirSync(repoDir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'pipe' })
    writeFileSync(join(repoDir, 'README.md'), 'base\n')
    execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' })
    execFileSync(
      'git',
      ['-C', repoDir, '-c', 'user.email=sup@test', '-c', 'user.name=Sup', 'commit', '-qm', 'base'],
      { stdio: 'pipe' }
    )
    const added = await stores.service.addRepository(repoDir)
    let writes = 0
    const service = new SupervisorService({
      userDataDir: root.dir,
      execPath: process.execPath,
      platform: process.platform,
      now: () => 1_700_000_000_000,
      store: new SupervisorStore(db),
      sessions: {
        create: async (input: { repoId: string; harness: string }, options?: { role?: string }) =>
          summary(input.repoId, input.harness, options?.role ?? 'interactive'),
        get: async () => summary(added.repository.id, 'claude', 'supervisor'),
        write: async () => {
          writes += 1
        },
        restart: async () => summary(added.repository.id, 'claude', 'supervisor'),
        wake: async () => summary(added.repository.id, 'claude', 'supervisor')
      } as never,
      tasks: {} as never,
      taskStore: {} as never,
      repositories: stores.repositories,
      gitWorkspace: {} as never,
      workspaceFiles: {} as never,
      bootstrapDelayMs: 0,
      listHarnesses: async () =>
        [{ harness: 'claude', state: 'available' } as HarnessDetectionResult]
    })
    await service.start()
    cleanups.push(async () => {
      await service.stop()
      db.close()
      root.cleanup()
    })
    await service.open(added.repository.id as never)
    const afterFirst = writes
    await service.open(added.repository.id as never)
    expect(writes).toBe(afterFirst)
  })

  it('proposes tasks through the control token and leaves them pending', async () => {
    const root = makeTempRoot('icode-supervisor-service-')
    const db = openTempDatabase(root)
    const stores = makeRepositoryService(db)
    const repoDir = join(root.dir, 'repo')
    mkdirSync(repoDir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'pipe' })
    writeFileSync(join(repoDir, 'README.md'), 'base\n')
    execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' })
    execFileSync(
      'git',
      ['-C', repoDir, '-c', 'user.email=sup@test', '-c', 'user.name=Sup', 'commit', '-qm', 'base'],
      { stdio: 'pipe' }
    )
    const added = await stores.service.addRepository(repoDir)
    const taskStore = new TaskStore(db)
    let sequence = 0
    const sessions = {
      create: async (input: { repoId: string; harness: string }, options?: { role?: string }) =>
        summary(input.repoId, input.harness, options?.role ?? 'interactive'),
      get: async () => summary(added.repository.id, 'claude', 'supervisor'),
      write: async () => undefined,
      restart: async () => summary(added.repository.id, 'claude', 'supervisor'),
      wake: async () => summary(added.repository.id, 'claude', 'supervisor')
    }
    const taskService = new TaskService({
      tasks: taskStore,
      repositories: stores.repositories,
      sessions: sessions as never,
      now: () => 1_700_000_000_000,
      newId: () => {
        sequence += 1
        return `task_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
      },
      isSessionLive: () => false,
      listChanges: async () => ({ status: 'unavailable', reason: 'test', detail: 'test' }),
      onQueueChanged: () => undefined
    })
    const service = new SupervisorService({
      userDataDir: root.dir,
      execPath: process.execPath,
      platform: process.platform,
      now: () => 1_700_000_000_000,
      store: new SupervisorStore(db),
      sessions: sessions as never,
      tasks: taskService,
      taskStore,
      repositories: stores.repositories,
      gitWorkspace: {} as never,
      workspaceFiles: {} as never,
      bootstrapDelayMs: 0,
      listHarnesses: async () =>
        [{ harness: 'claude', state: 'available' } as HarnessDetectionResult]
    })
    await service.start()
    cleanups.push(async () => {
      await service.stop()
      db.close()
      root.cleanup()
    })
    await service.open(added.repository.id as never)
    const binding = new SupervisorStore(db).findByRepo(added.repository.id as never)!
    const handle = (
      service as unknown as {
        handleControl: (request: SupervisorControlRequest) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>
      }
    ).handleControl.bind(service)

    const proposed = await handle({
      v: 1,
      token: binding.controlToken,
      op: 'tasks.propose',
      input: { tasks: [{ title: 'Add search', prompt: 'Add a search box to the header.' }] }
    })
    expect(proposed.ok).toBe(true)
    const tasks = taskStore.list({ repoId: added.repository.id as never })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      title: 'Add search',
      origin: 'supervisor',
      approval: 'pending',
      status: 'queued'
    })

    const state = await handle({
      v: 1,
      token: binding.controlToken,
      op: 'state',
      input: {}
    }) as { ok: boolean; value: { counts: { pendingApproval: number } } }
    expect(state.ok).toBe(true)
    expect(state.value.counts.pendingApproval).toBe(1)

    const cancelled = await handle({
      v: 1,
      token: binding.controlToken,
      op: 'tasks.cancel',
      input: { taskId: tasks[0]!.id }
    })
    expect(cancelled.ok).toBe(true)
    expect(taskStore.findById(tasks[0]!.id)!.status).toBe('cancelled')
  })
})

function summary(repoId: string, harness: string, role: string): SessionSummary {
  return {
    id: 'ses_00000000-0000-4000-8000-000000000001',
    repoId,
    title: 'Supervisor',
    harness,
    role,
    state: 'live',
    authority: 'host',
    reason: 'host_live',
    incarnationId: 'inc_0000000000000001',
    exitCode: null,
    error: null,
    updatedAt: 1_700_000_000_000,
    sleeping: false,
    worktree: null,
    activity: null
  } as SessionSummary
}
