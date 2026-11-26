import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ItemService, ItemError } from './item-service'
import { ItemStore } from './item-store'
import { TaskStore } from '../tasks/task-store'
import { TaskService } from '../tasks/task-service'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import type { SessionService } from '../sessions/session-service'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

async function harness(): Promise<{
  service: ItemService
  store: ItemStore
  taskStore: TaskStore
  taskId: string
  db: ReturnType<typeof openTempDatabase>
  clock: { now: number }
}> {
  const root = makeTempRoot('icode-items-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
  const repoDir = `${root.dir}/repo`
  mkdirSync(repoDir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'pipe' })
  writeFileSync(`${repoDir}/README.md`, 'base\n')
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', repoDir, '-c', 'user.email=items@test', '-c', 'user.name=Items', 'commit', '-qm', 'base'],
    { stdio: 'pipe' }
  )
  const added = await stores.service.addRepository(repoDir)
  const taskStore = new TaskStore(db)
  const clock = { now: new Date(2026, 10, 26, 9, 0, 0).getTime() }
  db.raw
    .prepare(
      `INSERT INTO bots (id, name, role, avatar_color, instructions, settings_json,
         archived_at, created_at, updated_at, paused_at)
       VALUES ('backend', 'Backend', 'Engineer', '#5b8def', '', NULL, NULL, ?, ?, NULL)`
    )
    .run(clock.now, clock.now)
  let sequence = 0
  const taskService = new TaskService({
    tasks: taskStore,
    repositories: stores.repositories,
    sessions: { create: async () => ({ id: 'ses_00000000-0000-4000-8000-000000000001' }) } as unknown as SessionService,
    now: () => clock.now,
    newId: () => {
      sequence += 1
      return `task_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
    },
    isSessionLive: () => false,
    listChanges: async () => ({ status: 'unavailable', reason: 'not-wired', detail: 'test' }),
    onQueueChanged: () => undefined
  })
  const created = taskService.create({
    repoId: added.repository.id,
    title: 'Login flow',
    prompt: 'Fix the login flow',
    harness: 'shell',
    botId: 'backend',
    groupId: 'group_1',
    groupThreadId: 'gthread_1'
  })
  if (!created.ok) throw new Error(created.error.message)
  let id = 0
  const store = new ItemStore(db)
  const service = new ItemService({
    tasks: taskStore,
    items: store,
    now: () => clock.now,
    newId: (prefix) => `${prefix}_${++id}`
  })
  cleanups.push(() => {
    db.close()
    root.cleanup()
  })
  return { service, store, taskStore, taskId: created.value.id, db, clock }
}

describe('item service', () => {
  it('derives planned, needs-you and answered states from the task and question', async () => {
    const { service, taskId } = await harness()
    const planned = service.list({ groupId: 'group_1' })
    expect(planned.items).toHaveLength(1)
    expect(planned.items[0]).toMatchObject({
      status: 'planned',
      openQuestion: null,
      links: []
    })
    expect(planned.counts.planned).toBe(1)

    const question = service.ask({
      taskId,
      body: 'Which flow should I use?',
      options: ['OAuth', 'Password'],
      authorKind: 'bot',
      authorBotId: 'backend',
      authorName: 'Backend'
    })
    expect(service.list({ groupId: 'group_1' }).items[0]).toMatchObject({
      status: 'needs_you',
      openQuestion: { id: question.id }
    })

    const answered = service.answer({
      taskId,
      questionId: question.id,
      body: 'OAuth.'
    })
    expect(answered.answer).toMatchObject({ kind: 'answer', replyToId: question.id })
    expect(answered.question.answeredAt).not.toBeNull()
    const after = service.list({ groupId: 'group_1' }).items[0]
    expect(after).toMatchObject({ status: 'planned', openQuestion: null })
    expect(after?.comments.map((comment) => comment.kind)).toEqual(['question', 'answer'])
    expect(() =>
      service.answer({ taskId, questionId: question.id, body: 'Again.' })
    ).toThrow(ItemError)
  })

  it('stores and removes owner-visible attachments', async () => {
    const { service, taskId } = await harness()
    const attachment = service.attach({
      taskId,
      name: 'log.txt',
      mime: 'text/plain',
      size: 2,
      dataUrl: 'data:text/plain;base64,aGk='
    })
    expect(service.get(taskId)?.attachments).toEqual([attachment])
    expect(service.removeAttachment(taskId, attachment.id)).toBe(true)
    expect(service.get(taskId)?.attachments).toEqual([])
    expect(service.removeAttachment(taskId, attachment.id)).toBe(false)
  })

  it('lets the owner set and clear a manual item status', async () => {
    const { service, taskId } = await harness()
    expect(service.setStatus(taskId, 'done').status).toBe('done')
    expect(service.setStatus(taskId, 'needs_you').status).toBe('needs_you')
    expect(service.setStatus(taskId, null).status).toBe('planned')
  })

  it('raises one worker question at a time and opens a new one after the answer', async () => {
    const { service, taskId } = await harness()
    const first = service.askWorker(taskId, 'Which database?', 'worker-question:1')
    expect(first).toMatchObject({ kind: 'question', authorKind: 'system' })
    expect(service.askWorker(taskId, 'Second question?', 'worker-question:2')).toBeNull()
    service.answer({ taskId, questionId: first!.id, body: 'Postgres.' })
    const second = service.askWorker(taskId, 'And the cache?', 'worker-question:3')
    expect(second).not.toBeNull()
    expect(service.list().items[0]).toMatchObject({
      status: 'needs_you',
      openQuestion: { id: second!.id }
    })
  })

  it('dedupes comments and validates an answer option', async () => {
    const { service, taskId } = await harness()
    const first = service.comment({
      taskId,
      body: 'Started.',
      authorKind: 'bot',
      authorBotId: 'backend',
      dedupeKey: 'task:started'
    })
    const second = service.comment({
      taskId,
      body: 'Started again.',
      authorKind: 'bot',
      authorBotId: 'backend',
      dedupeKey: 'task:started'
    })
    expect(second.id).toBe(first.id)
    expect(() =>
      service.ask({
        taskId,
        body: 'Pick one',
        options: ['A'],
        recommendedOption: 'B',
        authorKind: 'bot'
      })
    ).toThrow(ItemError)
  })

  it('snoozes stale needs-you items and attaches links', async () => {
    const { service, taskId, taskStore, db, clock } = await harness()
    db.raw
      .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
      .run(clock.now - 30 * 24 * 60 * 60 * 1000, taskId)
    expect(service.list({ groupId: 'group_1' }).items[0]?.stale).toBe(true)
    service.snooze(taskId, clock.now + 24 * 60 * 60 * 1000)
    expect(taskStore.findById(taskId)?.snoozedUntil).toBe(clock.now + 24 * 60 * 60 * 1000)
    expect(service.list({ groupId: 'group_1' }).items[0]?.stale).toBe(false)

    const link = service.linkAdd({ taskId, kind: 'pr', ref: 'https://example.com/pr/1' })
    expect(link).toMatchObject({ kind: 'pr', ref: 'https://example.com/pr/1' })
    expect(service.get(taskId)?.links).toHaveLength(1)
    expect(service.linkRemove({ taskId, kind: 'pr', ref: link.ref })).toBe(true)
    expect(service.get(taskId)?.links).toEqual([])
  })

  it('maps failed and completed tasks without a second stored status', async () => {
    const { service, taskId, db } = await harness()
    db.raw.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(taskId)
    expect(service.get(taskId)?.status).toBe('needs_you')
    db.raw
      .prepare("UPDATE tasks SET status = 'completed', review_decision = 'accepted' WHERE id = ?")
      .run(taskId)
    expect(service.get(taskId)?.status).toBe('done')
  })
})
