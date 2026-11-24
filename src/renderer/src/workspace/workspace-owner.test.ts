import { describe, expect, it } from 'vitest'
import {
  resolveWorkspaceOwner,
  sessionsForWorkspace,
  workspaceDescriptorFor,
  type WorkspaceOwnerSession
} from './workspace-owner'

function session(
  id: string,
  state: WorkspaceOwnerSession['state'],
  worktreePath: string | null = null,
  repoId = 'repo_1'
): WorkspaceOwnerSession {
  return {
    id,
    repoId,
    state,
    worktree:
      worktreePath === null
        ? null
        : ({ path: worktreePath } as unknown as NonNullable<WorkspaceOwnerSession['worktree']>)
  }
}

describe('resolveWorkspaceOwner', () => {
  it('prefers the active session when it belongs to the workspace', () => {
    const sessions = [session('ses_a', 'exited'), session('ses_b', 'live')]
    expect(
      resolveWorkspaceOwner({
        sessions,
        workspaceKey: 'default:repo_1',
        activeSessionId: 'ses_a'
      })?.id
    ).toBe('ses_a')
  })

  it('ignores an active session in another workspace and uses the remembered one', () => {
    const sessions = [
      session('ses_a', 'live'),
      session('ses_b', 'exited', '/checkouts/one'),
      session('ses_c', 'exited')
    ]
    expect(
      resolveWorkspaceOwner({
        sessions,
        workspaceKey: 'worktree:/checkouts/one',
        activeSessionId: 'ses_a',
        lastSessionByWorkspace: { 'worktree:/checkouts/one': 'ses_b' }
      })?.id
    ).toBe('ses_b')
  })

  it('falls back to a live session when the remembered session is gone', () => {
    const sessions = [session('ses_a', 'exited'), session('ses_b', 'starting')]
    expect(
      resolveWorkspaceOwner({
        sessions,
        workspaceKey: 'default:repo_1',
        lastSessionByWorkspace: { 'default:repo_1': 'ses_gone' }
      })?.id
    ).toBe('ses_b')
  })

  it('falls back to any remaining session so exited checkout rows still resolve', () => {
    const sessions = [session('ses_a', 'exited'), session('ses_b', 'failed')]
    expect(resolveWorkspaceOwner({ sessions, workspaceKey: 'default:repo_1' })?.id).toBe('ses_a')
  })

  it('returns null for a workspace with no sessions', () => {
    expect(
      resolveWorkspaceOwner({
        sessions: [session('ses_a', 'live', '/checkouts/one')],
        workspaceKey: 'default:repo_1'
      })
    ).toBeNull()
  })
})

describe('sessionsForWorkspace', () => {
  it('filters by worktree path and default checkout', () => {
    const sessions = [
      session('ses_a', 'live'),
      session('ses_b', 'live', '/checkouts/one'),
      session('ses_c', 'live', '/checkouts/two')
    ]
    expect(sessionsForWorkspace(sessions, 'default:repo_1').map((entry) => entry.id)).toEqual([
      'ses_a'
    ])
    expect(
      sessionsForWorkspace(sessions, 'worktree:/checkouts/one').map((entry) => entry.id)
    ).toEqual(['ses_b'])
  })
})

describe('workspaceDescriptorFor', () => {
  it('describes a worktree with one of its sessions', () => {
    const sessions = [session('ses_a', 'live', '/checkouts/one')]
    expect(
      workspaceDescriptorFor({
        workspaceKey: 'worktree:/checkouts/one',
        repoId: 'repo_1',
        sessions
      })
    ).toMatchObject({
      workspaceKey: 'worktree:/checkouts/one',
      repoId: 'repo_1',
      worktreePath: '/checkouts/one',
      worktreeBranch: null,
      isDefault: false
    })
  })

  it('describes an empty default checkout from the key alone', () => {
    expect(
      workspaceDescriptorFor({
        workspaceKey: 'default:repo_1',
        repoId: 'repo_1',
        sessions: []
      })
    ).toEqual({
      workspaceKey: 'default:repo_1',
      repoId: 'repo_1',
      worktreeId: null,
      worktreePath: null,
      worktreeBranch: null,
      isDefault: true
    })
  })
})
