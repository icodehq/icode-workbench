import type { SessionSummary } from '../../../shared/schemas/ipc'
import { isActiveSessionState } from '../../../shared/domain/session'
import { defaultWorkspaceKey, workspaceKeyForSession } from './workspace-key'

/**
 * The session a worktree uses as its IPC/watcher/SCM owner.
 *
 * Workspace state is keyed by the checkout, but every Files/Git IPC still
 * resolves a checkout through a session. The owner is the last focused session
 * in the worktree when it still exists, then a live/starting session, then any
 * remaining direct session (exited and sleeping rows still resolve their
 * checkout), and finally none.
 */
export type WorkspaceOwnerSession = Pick<
  SessionSummary,
  'id' | 'repoId' | 'worktree' | 'state'
>

export function sessionsForWorkspace<T extends Pick<SessionSummary, 'repoId' | 'worktree'>>(
  sessions: readonly T[],
  workspaceKey: string
): T[] {
  return sessions.filter((session) => workspaceKeyForSession(session) === workspaceKey)
}

export function resolveWorkspaceOwner<T extends WorkspaceOwnerSession>(input: {
  /** Direct (non-task) sessions. Task-owned sessions never own a workspace. */
  sessions: readonly T[]
  workspaceKey: string
  activeSessionId?: string | null
  /** Last focused session per workspace, from the workspace state. */
  lastSessionByWorkspace?: Readonly<Record<string, string>>
}): T | null {
  const inWorkspace = sessionsForWorkspace(input.sessions, input.workspaceKey)
  if (inWorkspace.length === 0) return null

  const active = input.activeSessionId ?? null
  if (active !== null) {
    const found = inWorkspace.find((session) => session.id === active)
    if (found !== undefined) return found
  }

  const remembered = input.lastSessionByWorkspace?.[input.workspaceKey]
  if (remembered !== undefined) {
    const found = inWorkspace.find((session) => session.id === remembered)
    if (found !== undefined) return found
  }

  const live = inWorkspace.find((session) => isActiveSessionState(session.state))
  if (live !== undefined) return live

  return inWorkspace[0] ?? null
}

export type WorkspaceDescriptor = {
  workspaceKey: string
  repoId: string
  worktreeId: string | null
  worktreePath: string | null
  worktreeBranch: string | null
  isDefault: boolean
}

/**
 * Everything the worktree bar, `+` menu and pending surface need to target a
 * workspace. A worktree only exists in the current model while at least one of
 * its sessions exists, so `worktreeId` is null for an unreachable checkout.
 */
export function workspaceDescriptorFor(input: {
  workspaceKey: string
  repoId: string
  sessions: readonly Pick<SessionSummary, 'repoId' | 'worktree'>[]
}): WorkspaceDescriptor {
  const session = input.sessions.find(
    (candidate) => workspaceKeyForSession(candidate) === input.workspaceKey
  )
  const worktree = session?.worktree ?? null
  const keyPath = input.workspaceKey.startsWith('worktree:')
    ? input.workspaceKey.slice('worktree:'.length)
    : null
  return {
    workspaceKey: input.workspaceKey,
    repoId: input.repoId,
    worktreeId: worktree?.id ?? null,
    worktreePath: worktree?.path ?? keyPath,
    worktreeBranch: worktree?.branch ?? null,
    isDefault: input.workspaceKey === defaultWorkspaceKey(input.repoId)
  }
}
