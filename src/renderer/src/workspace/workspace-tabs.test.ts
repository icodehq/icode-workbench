import { describe, expect, it } from 'vitest'
import {
  isPreviewReplaceable,
  scopeKeyForSession,
  workspaceKeyForSession,
  type WorkspaceTab
} from './workspace-tabs'

const tab = (preview: boolean): WorkspaceTab => ({
  key: 'src/a.ts',
  kind: 'file',
  preview,
  sessionId: 'ses_a'
})

describe('workspace tabs interface', () => {
  it('scopes tabs by session today and by worktree at the workspace layer', () => {
    expect(scopeKeyForSession({ id: 'ses_a' })).toBe('ses_a')
    expect(
      workspaceKeyForSession({
        repoId: 'repo_1',
        worktree: null
      } as Parameters<typeof workspaceKeyForSession>[0])
    ).toBe('default:repo_1')
    expect(
      workspaceKeyForSession({
        repoId: 'repo_1',
        worktree: { path: '/checkouts/one' }
      } as Parameters<typeof workspaceKeyForSession>[0])
    ).toBe('worktree:/checkouts/one')
  })

  it('only replaces a preview that has no unsaved text', () => {
    expect(isPreviewReplaceable(tab(true), false)).toBe(true)
    expect(isPreviewReplaceable(tab(true), true)).toBe(false)
    expect(isPreviewReplaceable(tab(false), false)).toBe(false)
  })
})
