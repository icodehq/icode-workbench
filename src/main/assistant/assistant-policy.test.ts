import { describe, expect, it, vi } from 'vitest'
import { AssistantPolicy } from './assistant-policy'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'
import type { TaskStore } from '../tasks/task-store'

function policy(counts: { repo?: number; total?: number } = {}) {
  const tasks = {
    countAutoDispatchedSince: vi.fn((_actor: string, _since: number, repoId?: string) =>
      repoId === undefined ? (counts.total ?? 0) : (counts.repo ?? 0)
    )
  } as unknown as TaskStore
  return new AssistantPolicy({ tasks, now: () => new Date('2026-11-08T12:00:00').getTime() })
}

const settings = DEFAULT_ASSISTANT_SETTINGS.autoDispatch

describe('Mira low-risk policy', () => {
  it('auto-approves a safe task within both caps', () => {
    const decision = policy().classify({
      repoId: 'repo_a' as never,
      title: 'Add retry docs',
      prompt: 'Update docs/retries.md.',
      settings
    })
    expect(decision.autoApprove).toBe(true)
    expect(decision.reasons).toEqual([])
  })

  it('keeps protected keywords and paths behind the human gate', () => {
    const keyword = policy().classify({
      repoId: 'repo_a' as never,
      title: 'Change auth',
      prompt: 'Update the auth flow.',
      settings
    })
    expect(keyword.autoApprove).toBe(false)
    expect(keyword.reasons.join(' ')).toContain('auth')

    const path = policy().classify({
      repoId: 'repo_a' as never,
      title: 'Add migration',
      prompt: 'Edit migrations/001.sql.',
      settings
    })
    expect(path.autoApprove).toBe(false)
    expect(path.reasons.join(' ')).toContain('migrations/')
  })

  it('stops at the daily caps', () => {
    const perProject = policy({ repo: settings.dailyCapPerProject }).classify({
      repoId: 'repo_a' as never,
      title: 'Docs',
      prompt: 'Write docs.',
      settings
    })
    expect(perProject.autoApprove).toBe(false)
    expect(perProject.reasons.join(' ')).toContain('project')

    const global = policy({ total: settings.dailyCapGlobal }).classify({
      repoId: 'repo_a' as never,
      title: 'Docs',
      prompt: 'Write docs.',
      settings
    })
    expect(global.autoApprove).toBe(false)
    expect(global.reasons.join(' ')).toContain('global')
  })

  it('honours off and all modes', () => {
    const off = policy().classify({
      repoId: 'repo_a' as never,
      title: 'Docs',
      prompt: 'Write docs.',
      settings: { ...settings, mode: 'off' }
    })
    expect(off.autoApprove).toBe(false)

    const all = policy().classify({
      repoId: 'repo_a' as never,
      title: 'Change auth',
      prompt: 'Update auth.',
      settings: { ...settings, mode: 'all' }
    })
    expect(all.autoApprove).toBe(true)
  })
})
