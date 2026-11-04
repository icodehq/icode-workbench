import { describe, expect, it } from 'vitest'
import { newRepoId, newSessionId } from '../domain/ids'
import { makeAppError } from '../domain/errors'
import {
  IPC_CHANNELS,
  addRepositoryInputSchema,
  createSessionInputSchema,
  ipcResultSchema,
  removeRepositoryInputSchema,
  rendererSessionEventSchema,
  repositorySummarySchema,
  sessionSummarySchema,
  terminalAttachInputSchema,
  terminalResizeInputSchema,
  terminalWriteInputSchema
} from './ipc'

const repoId = newRepoId()
const sessionId = newSessionId()
const incarnationId = '56260a795d16b072'

describe('channel map', () => {
  it('is namespaced and unique', () => {
    const values = Object.values(IPC_CHANNELS)
    expect(new Set(values).size).toBe(values.length)
    for (const channel of values) expect(channel.startsWith('ade:')).toBe(true)
  })
})

describe('repository inputs', () => {
  it('accepts an absolute path and rejects relative, NUL, and unknown fields', () => {
    expect(addRepositoryInputSchema.safeParse({ path: '/home/dev/repos/atlas' }).success).toBe(true)
    expect(addRepositoryInputSchema.safeParse({ path: 'repos/atlas' }).success).toBe(false)
    expect(addRepositoryInputSchema.safeParse({ path: '/tmp/at\0las' }).success).toBe(false)
    expect(
      addRepositoryInputSchema.safeParse({ path: '/tmp/atlas', branch: 'main' }).success
    ).toBe(false)
  })

  it('requires a repo-prefixed ID for removal', () => {
    expect(removeRepositoryInputSchema.safeParse({ repoId }).success).toBe(true)
    expect(removeRepositoryInputSchema.safeParse({ repoId: sessionId }).success).toBe(false)
  })
})

describe('session inputs', () => {
  it('accepts the approved harness enum and optional title', () => {
    expect(
      createSessionInputSchema.safeParse({
        repoId,
        harness: 'claude',
        cols: 120,
        rows: 32
      }).success
    ).toBe(true)
    expect(
      createSessionInputSchema.safeParse({
        repoId,
        harness: 'opencode',
        title: 'Fix checkout race',
        cols: 120,
        rows: 32
      }).success
    ).toBe(true)
  })

  it('rejects unknown harnesses, bad repo IDs, and invalid dimensions', () => {
    const base = { repoId, harness: 'claude', cols: 120, rows: 32 }
    expect(createSessionInputSchema.safeParse({ ...base, harness: 'gemini' }).success).toBe(false)
    expect(createSessionInputSchema.safeParse({ ...base, repoId: sessionId }).success).toBe(false)
    expect(createSessionInputSchema.safeParse({ ...base, cols: 0 }).success).toBe(false)
    expect(createSessionInputSchema.safeParse({ ...base, rows: 1001 }).success).toBe(false)
  })

  it('rejects titles beyond the domain limit and control characters', () => {
    const base = { repoId, harness: 'claude', cols: 80, rows: 24 }
    expect(
      createSessionInputSchema.safeParse({ ...base, title: 'x'.repeat(121) }).success
    ).toBe(false)
    expect(createSessionInputSchema.safeParse({ ...base, title: 'bad\nline' }).success).toBe(false)
  })
})

describe('terminal inputs', () => {
  it('requires the host incarnation alongside the session ID', () => {
    expect(
      terminalWriteInputSchema.safeParse({ sessionId, incarnationId, data: 'ls\r' }).success
    ).toBe(true)
    expect(terminalWriteInputSchema.safeParse({ sessionId, data: 'ls\r' }).success).toBe(false)
    expect(
      terminalWriteInputSchema.safeParse({ sessionId, incarnationId: sessionId, data: 'ls\r' })
        .success
    ).toBe(false)
  })

  it('rejects oversized input by UTF-8 bytes', () => {
    expect(
      terminalWriteInputSchema.safeParse({
        sessionId,
        incarnationId,
        data: 'a'.repeat(1_048_577)
      }).success
    ).toBe(false)
  })

  it('validates attach and resize shapes', () => {
    expect(terminalAttachInputSchema.safeParse({ sessionId }).success).toBe(true)
    expect(
      terminalResizeInputSchema.safeParse({ sessionId, incarnationId, cols: 100, rows: 40 }).success
    ).toBe(true)
    expect(
      terminalResizeInputSchema.safeParse({ sessionId, incarnationId, cols: 100, rows: 0 }).success
    ).toBe(false)
  })
})

describe('output contracts', () => {
  const summary = {
    id: sessionId,
    repoId,
    title: 'Claude · atlas',
    harness: 'claude',
    state: 'live',
    authority: 'host',
    reason: 'host_live',
    incarnationId,
    exitCode: null,
    error: null,
    updatedAt: 1,
    worktree: null,
    activity: null
  }

  it('validates repository and session summaries', () => {
    expect(
      repositorySummarySchema.safeParse({
        id: repoId,
        displayName: 'atlas',
        path: '/home/dev/atlas',
        currentBranch: 'main',
        availability: 'present',
        target: { kind: 'local' },
        preparation: null
      }).success
    ).toBe(true)
    // A WSL target round-trips its registration identity untouched.
    expect(
      repositorySummarySchema.safeParse({
        id: repoId,
        displayName: 'atlas',
        path: '/home/dev/atlas',
        currentBranch: 'main',
        availability: 'present',
        target: { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: 'guid-a' },
        preparation: null
      }).success
    ).toBe(true)
    // A target is required: an omitted one is not silently read as local.
    expect(
      repositorySummarySchema.safeParse({
        id: repoId,
        displayName: 'atlas',
        path: '/home/dev/atlas',
        currentBranch: 'main',
        availability: 'present'
      }).success
    ).toBe(false)
    // A wsl target without a distro is invalid.
    expect(
      repositorySummarySchema.safeParse({
        id: repoId,
        displayName: 'atlas',
        path: '/home/dev/atlas',
        currentBranch: 'main',
        availability: 'present',
        target: { kind: 'wsl', distro: '', distroId: null }
      }).success
    ).toBe(false)
    expect(sessionSummarySchema.safeParse(summary).success).toBe(true)
    expect(sessionSummarySchema.safeParse({ ...summary, incarnationId: null }).success).toBe(true)
    expect(sessionSummarySchema.safeParse({ ...summary, state: 'running' }).success).toBe(false)
    expect(sessionSummarySchema.safeParse({ ...summary, reason: 'made_up' }).success).toBe(false)
  })

  it('wraps results in a discriminated envelope', () => {
    const schema = ipcResultSchema(repositorySummarySchema)
    expect(
      schema.safeParse({
        ok: true,
        value: {
          id: repoId,
          displayName: 'atlas',
          path: '/home/dev/atlas',
          currentBranch: null,
          availability: 'missing',
          target: { kind: 'local' },
          preparation: null
        }
      }).success
    ).toBe(true)
    expect(
      schema.safeParse({ ok: false, error: makeAppError('REPO_PATH_MISSING', 'Path is missing') })
        .success
    ).toBe(true)
    expect(
      schema.safeParse({
        ok: false,
        error: { code: 'REPO_PATH_MISSING', message: 'Path is missing', retryable: true }
      }).success
    ).toBe(false)
  })

  it('validates renderer events carry session and incarnation', () => {
    expect(
      rendererSessionEventSchema.safeParse({
        type: 'data',
        sessionId,
        incarnationId,
        seq: 1,
        data: 'x'
      }).success
    ).toBe(true)
    expect(
      rendererSessionEventSchema.safeParse({ type: 'data', sessionId, seq: 1, data: 'x' }).success
    ).toBe(false)
    expect(
      rendererSessionEventSchema.safeParse({ type: 'state', session: summary }).success
    ).toBe(true)
    expect(
      rendererSessionEventSchema.safeParse({
        type: 'activity',
        sessionId,
        activity: { state: 'working', toolName: 'Bash', unread: false, outcome: null, since: 1 }
      }).success
    ).toBe(true)
    expect(
      rendererSessionEventSchema.safeParse({ type: 'activity-focus', sessionId }).success
    ).toBe(true)
    expect(
      rendererSessionEventSchema.safeParse({
        type: 'activity',
        sessionId,
        activity: { state: 'bogus' }
      }).success
    ).toBe(false)
    expect(rendererSessionEventSchema.safeParse({ type: 'tick' }).success).toBe(false)
  })
})
