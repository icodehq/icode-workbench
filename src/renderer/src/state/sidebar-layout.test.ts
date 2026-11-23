import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_PROJECTS_MIN,
  SIDEBAR_SECTION_SEAM,
  SIDEBAR_TASKS_HEIGHT_KEY,
  SIDEBAR_TASKS_HEIGHT_MAX,
  SIDEBAR_TASKS_MIN,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarTasksHeight,
  clampSidebarWidth,
  loadSidebarTasksHeight,
  loadSidebarWidth,
  saveSidebarTasksHeight,
  saveSidebarWidth,
  sidebarTasksMax
} from './sidebar-layout'

function storage(initial: string | null = null) {
  let value = initial
  return {
    getItem: (key: string) => (key === SIDEBAR_WIDTH_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === SIDEBAR_WIDTH_KEY) value = next
    }
  }
}

describe('sidebar layout', () => {
  it('defaults to 300 and clamps into the drag bounds', () => {
    expect(loadSidebarWidth(storage())).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(loadSidebarWidth(storage('100'))).toBe(SIDEBAR_WIDTH_MIN)
    expect(loadSidebarWidth(storage('900'))).toBe(SIDEBAR_WIDTH_MAX)
    expect(loadSidebarWidth(storage('nope'))).toBe(SIDEBAR_WIDTH_DEFAULT)
  })

  it('round-trips the preferred width', () => {
    const store = storage()
    expect(saveSidebarWidth(360, store)).toBe(true)
    expect(loadSidebarWidth(store)).toBe(360)
    expect(saveSidebarWidth(999, store)).toBe(true)
    expect(loadSidebarWidth(store)).toBe(SIDEBAR_WIDTH_MAX)
  })

  it('reports a failed save without throwing', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(saveSidebarWidth(300, failing)).toBe(false)
  })

  it('rounds and clamps direct values', () => {
    expect(clampSidebarWidth(319.6)).toBe(320)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT)
  })
})

function tasksStorage(initial: string | null = null) {
  let value = initial
  return {
    getItem: (key: string) => (key === SIDEBAR_TASKS_HEIGHT_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === SIDEBAR_TASKS_HEIGHT_KEY) value = next
    },
    removeItem: (key: string) => {
      if (key === SIDEBAR_TASKS_HEIGHT_KEY) value = null
    }
  }
}

describe('sidebar tasks pane', () => {
  it('defaults to content-sized until a height is stored', () => {
    expect(loadSidebarTasksHeight(tasksStorage())).toBeNull()
    expect(loadSidebarTasksHeight(tasksStorage('nope'))).toBeNull()
  })

  it('clamps stored values into the storage bounds', () => {
    expect(loadSidebarTasksHeight(tasksStorage('10'))).toBe(SIDEBAR_TASKS_MIN)
    expect(loadSidebarTasksHeight(tasksStorage('99999'))).toBe(SIDEBAR_TASKS_HEIGHT_MAX)
    expect(loadSidebarTasksHeight(tasksStorage('240'))).toBe(240)
  })

  it('clamps a drag into the space the split can spare', () => {
    expect(clampSidebarTasksHeight(50, 500)).toBe(SIDEBAR_TASKS_MIN)
    expect(clampSidebarTasksHeight(999, 500)).toBe(
      500 - SIDEBAR_PROJECTS_MIN - SIDEBAR_SECTION_SEAM
    )
    expect(clampSidebarTasksHeight(200.6, 500)).toBe(201)
    expect(clampSidebarTasksHeight(Number.NaN, 500)).toBe(SIDEBAR_TASKS_MIN)
    expect(sidebarTasksMax(0)).toBe(SIDEBAR_TASKS_MIN)
    expect(sidebarTasksMax(99999)).toBe(SIDEBAR_TASKS_HEIGHT_MAX)
  })

  it('round-trips and clears the preference', () => {
    const store = tasksStorage()
    expect(saveSidebarTasksHeight(240, store)).toBe(true)
    expect(loadSidebarTasksHeight(store)).toBe(240)
    expect(saveSidebarTasksHeight(null, store)).toBe(true)
    expect(loadSidebarTasksHeight(store)).toBeNull()
  })

  it('reports a failed save without throwing', () => {
    const failing = {
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('quota')
      }
    }
    expect(saveSidebarTasksHeight(240, failing)).toBe(false)
    expect(saveSidebarTasksHeight(null, failing)).toBe(false)
  })
})
