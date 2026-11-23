import { beforeEach, describe, expect, it } from 'vitest'
import {
  getExpandedProjectIds,
  resetSidebarExpansion,
  setProjectExpanded,
  subscribeSidebarExpansion,
  toggleProjectExpanded
} from './sidebar-expansion'

beforeEach(() => resetSidebarExpansion())

describe('sidebar expansion', () => {
  it('starts with every project collapsed', () => {
    expect(getExpandedProjectIds().size).toBe(0)
  })

  it('toggles a project open and closed', () => {
    toggleProjectExpanded('repo-a')
    expect([...getExpandedProjectIds()]).toEqual(['repo-a'])

    toggleProjectExpanded('repo-a')
    expect(getExpandedProjectIds().size).toBe(0)
  })

  it('keeps independent projects and a stable snapshot between changes', () => {
    toggleProjectExpanded('repo-a')
    const snapshot = getExpandedProjectIds()
    const open = new Set(['repo-a', 'repo-b'])
    setProjectExpanded('repo-b', true)
    expect(getExpandedProjectIds()).not.toBe(snapshot)
    expect(new Set(getExpandedProjectIds())).toEqual(open)
  })

  it('notifies subscribers on a real change and stops after unsubscribe', () => {
    const seen: number[] = []
    const unsubscribe = subscribeSidebarExpansion(() => seen.push(1))
    toggleProjectExpanded('repo-a')
    setProjectExpanded('repo-a', true)
    setProjectExpanded('repo-a', false)
    unsubscribe()
    toggleProjectExpanded('repo-b')
    expect(seen).toEqual([1, 1])
  })

  it('resets to the launch default', () => {
    toggleProjectExpanded('repo-a')
    resetSidebarExpansion()
    expect(getExpandedProjectIds().size).toBe(0)
  })
})
