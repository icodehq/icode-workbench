import { describe, expect, it, vi } from 'vitest'
import { newSessionId } from '../../shared/domain/ids'
import { invokeGitCommand } from './git-commands'

function runtime() {
  const status = vi.fn(async () => ({ status: 'ok', snapshot: {} }))
  const changeDiff = vi.fn(async () => ({ status: 'available', patch: '' }))
  return {
    gitWorkspace: { status, changeDiff },
    gitStatusWatcher: { setActive: vi.fn() }
  } as never
}

function codeOf(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'appError' in error
    ? (error.appError as { code?: string }).code
    : undefined
}

describe('Git command registry', () => {
  it('validates and dispatches by operation name', async () => {
    const r = runtime()
    const sessionId = newSessionId()
    await expect(invokeGitCommand(r, { op: 'status', input: { sessionId } })).resolves.toMatchObject({
      status: 'ok'
    })
    expect((r as unknown as { gitWorkspace: { status: ReturnType<typeof vi.fn> } }).gitWorkspace.status).toHaveBeenCalledWith(sessionId)
  })

  it('rejects an unknown operation', async () => {
    await expect(invokeGitCommand(runtime(), { op: 'not-a-command', input: {} })).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT'
    )
  })

  it('rejects a missing or non-object envelope', async () => {
    for (const input of [null, 'status', 42]) {
      await expect(invokeGitCommand(runtime(), input)).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT'
      )
    }
    await expect(invokeGitCommand(runtime(), { input: {} })).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT'
    )
  })

  it('rejects invalid operation input before calling the handler', async () => {
    const r = runtime()
    await expect(
      invokeGitCommand(r, {
        op: 'changeDiff',
        input: { sessionId: newSessionId(), path: '../escape.ts' }
      })
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'INVALID_ARGUMENT')
    expect(
      (r as unknown as { gitWorkspace: { changeDiff: ReturnType<typeof vi.fn> } }).gitWorkspace
        .changeDiff
    ).not.toHaveBeenCalled()
  })
})
