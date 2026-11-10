import { describe, expect, it } from 'vitest'
import {
  CREATE_WORKTREE_SENTINEL,
  GUEST_CREATE_WORKTREE_SCRIPT,
  GUEST_INSPECT_FOR_CREATE_SCRIPT,
  INSPECT_FOR_CREATE_SENTINEL,
  parseCreateWorktree,
  parseInspectForCreate
} from './guest-session-scripts'

function inspect(body: string[]): string {
  return [
    'login banner',
    INSPECT_FOR_CREATE_SENTINEL,
    ...body,
    INSPECT_FOR_CREATE_SENTINEL,
    'trailing banner'
  ].join('\n')
}

describe('inspect-for-create payload', () => {
  it('parses a clean repository behind a login-shell banner', () => {
    const payload = parseInspectForCreate(
      inspect([
        'workspace=present',
        'root=present',
        'git=present',
        'verify_status=0',
        'head=abc123',
        'ref=main',
        'operation=',
        'unknown=ignored'
      ])
    )
    expect(payload).toEqual({
      workspacePresent: true,
      rootPresent: true,
      gitPresent: true,
      verifyStatus: 0,
      head: 'abc123',
      ref: 'main',
      operation: null
    })
  })

  it('keeps the operation marker', () => {
    const payload = parseInspectForCreate(
      inspect([
        'workspace=present',
        'root=present',
        'git=present',
        'verify_status=0',
        'head=abc',
        'ref=HEAD',
        'operation=rebase-merge'
      ])
    )
    expect(payload?.operation).toBe('rebase-merge')
    expect(payload?.ref).toBe('HEAD')
  })

  it('handles CRLF lines and an unborn repository', () => {
    const payload = parseInspectForCreate(
      [
        INSPECT_FOR_CREATE_SENTINEL,
        'workspace=present',
        'root=present',
        'git=present',
        'verify_status=128',
        'head=',
        'ref=',
        'operation=',
        INSPECT_FOR_CREATE_SENTINEL
      ].join('\r\n')
    )
    expect(payload).toMatchObject({ verifyStatus: 128, head: null, ref: null })
  })

  it('rejects a missing sentinel or a malformed required field', () => {
    expect(parseInspectForCreate('workspace=present\n')).toBeNull()
    expect(
      parseInspectForCreate(
        inspect([
          'workspace=maybe',
          'root=present',
          'git=present',
          'verify_status=0',
          'head=',
          'ref=',
          'operation='
        ])
      )
    ).toBeNull()
    expect(
      parseInspectForCreate(
        inspect([
          'workspace=present',
          'root=present',
          'git=present',
          'verify_status=nope',
          'head=',
          'ref=',
          'operation='
        ])
      )
    ).toBeNull()
  })

  it('uses positional parameters, never an interpolated path', () => {
    expect(GUEST_INSPECT_FOR_CREATE_SCRIPT).toContain('"$2"')
    expect(GUEST_INSPECT_FOR_CREATE_SCRIPT).toContain('"$3"')
    expect(GUEST_INSPECT_FOR_CREATE_SCRIPT).not.toContain('/home/')
  })
})

function create(body: string[]): string {
  return [CREATE_WORKTREE_SENTINEL, ...body, CREATE_WORKTREE_SENTINEL].join('\n')
}

describe('create-worktree payload', () => {
  it('reports an existing directory without touching Git', () => {
    expect(parseCreateWorktree(create(['exists=1']))).toEqual({ phase: 'exists' })
  })

  it('reports a directory-creation failure', () => {
    expect(parseCreateWorktree(create(['exists=0', 'mkdir=1']))).toEqual({
      phase: 'mkdir_failed',
      status: 1
    })
  })

  it('keeps raw Git output for an add failure', () => {
    const payload = parseCreateWorktree(
      create([
        'exists=0',
        'mkdir=0',
        'add=128',
        'add_begin',
        "fatal: 'icode/session-1' is already checked out",
        'add_end'
      ])
    )
    expect(payload).toEqual({
      phase: 'add_failed',
      status: 128,
      output: "fatal: 'icode/session-1' is already checked out"
    })
  })

  it('parses the created evidence, including the raw worktree list', () => {
    const payload = parseCreateWorktree(
      create([
        'exists=0',
        'mkdir=0',
        'add=0',
        'add_begin',
        'Preparing worktree',
        'add_end',
        'toplevel=/home/u/.icode/worktrees/scope/r1/s1',
        'head=abc123',
        'worktrees_begin',
        'worktree /home/u/src/atlas',
        '',
        'worktree /home/u/.icode/worktrees/scope/r1/s1',
        'worktrees_end'
      ])
    )
    expect(payload).toMatchObject({
      phase: 'created',
      topLevel: '/home/u/.icode/worktrees/scope/r1/s1',
      head: 'abc123'
    })
    if (payload?.phase === 'created') {
      expect(payload.worktrees).toContain('worktree /home/u/.icode/worktrees/scope/r1/s1')
    }
  })

  it('rejects a malformed payload', () => {
    expect(parseCreateWorktree('exists=0')).toBeNull()
    expect(parseCreateWorktree(create(['exists=0', 'mkdir=0', 'add=no']))).toBeNull()
  })

  it('uses positional parameters, never an interpolated path', () => {
    expect(GUEST_CREATE_WORKTREE_SCRIPT).toContain('"$2"')
    expect(GUEST_CREATE_WORKTREE_SCRIPT).toContain('"$3"')
    expect(GUEST_CREATE_WORKTREE_SCRIPT).not.toContain('/home/')
  })
})
