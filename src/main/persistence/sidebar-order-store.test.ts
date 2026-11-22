import { afterEach, describe, expect, it } from 'vitest'
import { makeTempRoot, openTempDatabase } from './persistence-test-fixtures'
import type { TempRoot } from './persistence-test-fixtures'
import type { Database } from './database'
import { SidebarOrderStore } from './sidebar-order-store'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function setup(): { root: TempRoot; db: Database; store: SidebarOrderStore } {
  const root = makeTempRoot('icode-sidebar-order-')
  cleanups.push(root.cleanup)
  const db = openTempDatabase(root)
  cleanups.push(() => db.close())
  return { root, db, store: new SidebarOrderStore(db) }
}

describe('sidebar_order', () => {
  it('returns an empty document before anything is saved', () => {
    const { store } = setup()
    expect(store.get()).toEqual({ projects: [], worktrees: {}, sessions: {} })
  })

  it('round-trips the order and deduplicates ids', () => {
    const { store } = setup()
    const saved = store.set({
      projects: ['repo_1', 'repo_2', 'repo_1'],
      worktrees: { repo_1: ['/checkouts/one', '/checkouts/two'] },
      sessions: { 'worktree:/checkouts/one': ['ses_1', 'ses_2', 'ses_1'] }
    })
    expect(saved).toEqual({
      projects: ['repo_1', 'repo_2'],
      worktrees: { repo_1: ['/checkouts/one', '/checkouts/two'] },
      sessions: { 'worktree:/checkouts/one': ['ses_1', 'ses_2'] }
    })
    expect(store.get()).toEqual(saved)
  })

  it('keeps one row across repeated writes', () => {
    const { db, store } = setup()
    store.set({ projects: ['repo_1'], worktrees: {}, sessions: {} })
    store.set({ projects: ['repo_2', 'repo_1'], worktrees: {}, sessions: {} })
    const rows = db.raw.prepare('SELECT COUNT(*) AS count FROM sidebar_order').get() as {
      count: number
    }
    expect(rows.count).toBe(1)
    expect(store.get().projects).toEqual(['repo_2', 'repo_1'])
  })

  it('ignores a corrupt document instead of failing startup', () => {
    const { db, store } = setup()
    db.raw
      .prepare('INSERT INTO sidebar_order (id, document, updated_at) VALUES (1, ?, 0)')
      .run('{not json')
    expect(store.get()).toEqual({ projects: [], worktrees: {}, sessions: {} })

    db.raw.prepare('UPDATE sidebar_order SET document = ? WHERE id = 1').run('{"projects":"no"}')
    expect(store.get()).toEqual({ projects: [], worktrees: {}, sessions: {} })
  })
})
