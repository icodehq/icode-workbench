import { describe, expect, it } from 'vitest'
import {
  PINNED_PROJECTS_KEY,
  PINNED_SESSIONS_KEY,
  PINNED_TASKS_KEY,
  pruneSidebarPins,
  readSidebarPins,
  togglePin,
  writeSidebarPins,
  type SidebarPins
} from './sidebar-pins'
import type { StorageLike } from '../projects-wall-model'

function storage(seed: Record<string, string> = {}): StorageLike & { values: Record<string, string> } {
  const values = { ...seed }
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    }
  }
}

describe('sidebar pins', () => {
  it('reads the legacy project key and the session key', () => {
    const target = storage({
      [PINNED_PROJECTS_KEY]: JSON.stringify(['demo', 'demo']),
      [PINNED_SESSIONS_KEY]: JSON.stringify(['ses-1', 42])
    })
    expect(readSidebarPins(target)).toEqual({ projects: ['demo'], sessions: ['ses-1'], tasks: [] })
  })

  it('writes both key sets and tolerates malformed data', () => {
    const target = storage({ [PINNED_PROJECTS_KEY]: '{' })
    expect(readSidebarPins(target).projects).toEqual([])
    const pins: SidebarPins = { projects: ['api'], sessions: ['ses-2'], tasks: ['task-1'] }
    writeSidebarPins(pins, target)
    expect(JSON.parse(target.values[PINNED_PROJECTS_KEY] ?? '[]')).toEqual(['api'])
    expect(JSON.parse(target.values[PINNED_SESSIONS_KEY] ?? '[]')).toEqual(['ses-2'])
    expect(JSON.parse(target.values[PINNED_TASKS_KEY] ?? '[]')).toEqual(['task-1'])
  })

  it('toggles a value without duplicating it', () => {
    expect(togglePin([], 'demo')).toEqual(['demo'])
    expect(togglePin(['demo'], 'demo')).toEqual([])
  })

  it('prunes removed repositories and sessions', () => {
    expect(
      pruneSidebarPins(
        { projects: ['demo', 'removed'], sessions: ['ses-1', 'gone'], tasks: ['task-1', 'gone'] },
        ['demo'],
        ['ses-1'],
        ['task-1']
      )
    ).toEqual({ projects: ['demo'], sessions: ['ses-1'], tasks: ['task-1'] })
  })
})
