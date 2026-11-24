import { describe, expect, it } from 'vitest'
import type { WorkingTreeEntry } from '../review/working-tree'
import {
  FILES_MAX_BUFFERED_CHARS,
  OpenFilesStore,
  fileTabs,
  isDirty,
  parsePersistedOpenFiles,
  sessionTabs,
  tabKey,
  type OpenFilesPersistence
} from './open-files'

function memoryPersistence(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial))
  const persistence: OpenFilesPersistence = {
    load: async (key) => values.get(key) ?? null,
    save: async (key, next) => {
      values.set(key, next)
    },
    remove: async (key) => {
      values.delete(key)
    }
  }
  return { persistence, read: (key: string) => values.get(key) }
}

describe('open files store', () => {
  it('reports a tab as dirty only when its text differs from the saved text', () => {
    const store = new OpenFilesStore()
    store.open('ses_a', 'one.ts')
    store.setContent('ses_a', 'one.ts', { text: 'const one = 1\n', etag: '1:12' })

    expect(isDirty(store.find('ses_a', 'one.ts')!)).toBe(false)

    store.updateText('ses_a', 'one.ts', 'const one = 2\n')
    expect(isDirty(store.find('ses_a', 'one.ts')!)).toBe(true)
  })

  it('keeps tabs per session and preserves unsaved text', () => {
    const store = new OpenFilesStore()
    store.open('ses_a', 'one.ts')
    store.setContent('ses_a', 'one.ts', { text: 'const one = 1\n', etag: '1:12' })
    store.open('ses_a', 'two.ts')
    store.setContent('ses_a', 'two.ts', { text: 'const two = 2\n', etag: '2:12' })
    store.updateText('ses_a', 'one.ts', 'const one = 10\n')

    expect(store.get('ses_a').activePath).toBe('two.ts')
    expect(store.dirtyCount('ses_a')).toBe(1)
    expect(store.find('ses_a', 'one.ts')?.text).toBe('const one = 10\n')

    store.setActive('ses_a', 'one.ts')
    expect(store.get('ses_a').activePath).toBe('one.ts')
    expect(fileTabs(store.get('ses_a')).map((tab) => tab.path)).toEqual(['one.ts', 'two.ts'])
  })

  it('closes the active tab onto its neighbour and clears the session last', () => {
    const store = new OpenFilesStore()
    store.open('ses_a', 'a.ts')
    store.open('ses_a', 'b.ts')
    store.open('ses_a', 'c.ts')
    store.setActive('ses_a', 'b.ts')
    store.closeTab('ses_a', 'b.ts')
    expect(store.get('ses_a').activePath).toBe('c.ts')
    store.closeTab('ses_a', 'c.ts')
    expect(store.get('ses_a').activePath).toBe('a.ts')
    store.closeTab('ses_a', 'a.ts')
    expect(store.get('ses_a')).toMatchObject({ tabs: [], activePath: null })
  })

  it('tracks the whole app dirty summary for the close guard', () => {
    const store = new OpenFilesStore()
    store.open('ses_a', 'a.ts')
    store.setContent('ses_a', 'a.ts', { text: 'a\n', etag: '1:2' })
    store.open('ses_b', 'b.ts')
    store.setContent('ses_b', 'b.ts', { text: 'b\n', etag: '2:2' })
    expect(store.dirtySummary()).toEqual({ files: 0, sessions: 0 })

    store.updateText('ses_a', 'a.ts', 'a changed\n')
    store.updateText('ses_b', 'b.ts', 'b changed\n')
    expect(store.dirtySummary()).toEqual({ files: 2, sessions: 2 })
    expect(store.allDirtyTabs().map((tab) => `${tab.scopeKey}:${tab.path}`)).toEqual([
      'ses_a:a.ts',
      'ses_b:b.ts'
    ])
  })

  it('follows an in-app rename for the moved tab and its children', () => {
    const store = new OpenFilesStore()
    store.open('ses_a', 'src/a.ts')
    store.open('ses_a', 'src/nested/b.ts')
    store.setActive('ses_a', 'src/nested/b.ts')
    store.renamePath('ses_a', 'src', 'lib')
    expect(fileTabs(store.get('ses_a')).map((tab) => tab.path)).toEqual([
      'lib/a.ts',
      'lib/nested/b.ts'
    ])
    expect(store.get('ses_a').activePath).toBe('lib/nested/b.ts')
  })

  it('adopts a disk version while keeping the user buffer', () => {
    const store = new OpenFilesStore()
    store.open('ses_a', 'a.ts')
    store.setContent('ses_a', 'a.ts', { text: 'mine\n', etag: 'v1' })
    store.updateText('ses_a', 'a.ts', 'mine changed\n')
    store.markDiskChanged('ses_a', 'a.ts')
    store.adoptDiskVersion('ses_a', 'a.ts', 'v2')
    const tab = store.find('ses_a', 'a.ts')
    expect(tab).toMatchObject({
      text: 'mine changed\n',
      savedText: 'mine\n',
      etag: 'v2',
      disk: 'current'
    })
    expect(store.dirtyCount('ses_a')).toBe(1)
  })

  it('drops removed sessions and refuses to exceed the buffer budget', () => {
    const store = new OpenFilesStore()
    store.open('ses_a', 'a.ts')
    store.setContent('ses_a', 'a.ts', { text: 'x'.repeat(10), etag: '1:10' })
    expect(store.canStore('ses_a', 'b.ts', FILES_MAX_BUFFERED_CHARS - 10)).toBe(true)
    expect(store.canStore('ses_a', 'b.ts', FILES_MAX_BUFFERED_CHARS - 9)).toBe(false)
    store.retain(new Set(['ses_b']))
    expect(store.get('ses_a').tabs).toEqual([])
  })

  it('restores tabs, dirty text and the active path after a hot exit', async () => {
    const memory = memoryPersistence()
    const first = new OpenFilesStore(memory.persistence, 0)
    first.open('ses_a', 'a.ts')
    first.setContent('ses_a', 'a.ts', { text: 'saved\n', etag: 'sha256:one' })
    first.updateText('ses_a', 'a.ts', 'dirty\n')
    first.open('ses_a', 'b.ts')
    first.setContent('ses_a', 'b.ts', { text: 'b\n', etag: 'sha256:two' })
    first.setActive('ses_a', 'a.ts')
    await first.flush()

    const second = new OpenFilesStore(memory.persistence, 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fileTabs(second.get('ses_a')).map((tab) => tab.path)).toEqual(['a.ts', 'b.ts'])
    expect(second.get('ses_a').activePath).toBe('a.ts')
    expect(second.find('ses_a', 'a.ts')).toMatchObject({
      text: 'dirty\n',
      savedText: 'saved\n',
      etag: 'sha256:one',
      load: 'ready'
    })
    expect(second.dirtyCount('ses_a')).toBe(1)
  })

  it('removes persisted tabs when a session is retained away', async () => {
    const memory = memoryPersistence()
    const first = new OpenFilesStore(memory.persistence, 0)
    first.open('ses_a', 'a.ts')
    first.setContent('ses_a', 'a.ts', { text: 'a\n', etag: '1:2' })
    await first.flush()
    first.retain(new Set())
    await first.flush()

    const second = new OpenFilesStore(memory.persistence, 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(second.get('ses_a').tabs).toEqual([])
  })

  it('rejects malformed hot-exit payloads and repairs an interrupted load', () => {
    expect(parsePersistedOpenFiles({ version: 2, sessions: {} }).size).toBe(0)
    expect(parsePersistedOpenFiles('nope').size).toBe(0)
    const parsed = parsePersistedOpenFiles({
      version: 1,
      sessions: {
        ses_a: {
          tabs: [
            {
              path: 'a.ts',
              text: '',
              savedText: '',
              original: null,
              etag: null,
              disk: 'current',
              load: 'loading',
              failure: null
            }
          ],
          activePath: 'a.ts'
        }
      }
    })
    expect(parsed.get('ses_a')?.tabs[0]).toMatchObject({
      load: 'failed',
      failure: expect.stringContaining('closed before')
    })
  })

  it('replaces the preview tab and pins on a permanent open or typing', () => {
    const store = new OpenFilesStore()
    store.open('ses_a', 'a.ts', { preview: true })
    expect(store.get('ses_a').tabs[0]).toMatchObject({ preview: true, path: 'a.ts' })

    const second = store.open('ses_a', 'b.ts', { preview: true })
    expect(second.replacedKey).toBe('file:a.ts')
    expect(fileTabs(store.get('ses_a')).map((tab) => tab.path)).toEqual(['b.ts'])
    expect(store.get('ses_a').tabs[0]).toMatchObject({ preview: true })

    store.open('ses_a', 'b.ts', { preview: false })
    expect(store.get('ses_a').tabs[0]).toMatchObject({ preview: false })
    store.open('ses_a', 'c.ts', { preview: true })
    expect(fileTabs(store.get('ses_a')).map((tab) => tab.path)).toEqual(['b.ts', 'c.ts'])

    store.updateText('ses_a', 'c.ts', 'typed')
    expect(store.find('ses_a', 'c.ts')).toMatchObject({ preview: false, text: 'typed' })
  })

  it('returns to the terminal when the last tab closes', () => {
    const store = new OpenFilesStore()
    store.open('ses_a', 'a.ts')
    store.open('ses_a', 'b.ts')
    store.open('ses_a', 'c.ts')
    store.setActiveKey('ses_a', 'b.ts')
    expect(store.get('ses_a').mode).toBe('editor')

    store.closeTab('ses_a', 'b.ts')
    expect(store.get('ses_a').activeKey).toBe('file:c.ts')
    store.closeTab('ses_a', 'c.ts')
    expect(store.get('ses_a').activeKey).toBe('file:a.ts')
    store.closeTab('ses_a', 'a.ts')
    expect(store.get('ses_a')).toMatchObject({
      tabs: [],
      activeKey: null,
      activePath: null,
      mode: 'terminal'
    })

    store.open('ses_a', 'd.ts')
    store.setMode('ses_a', 'terminal')
    expect(store.get('ses_a')).toMatchObject({ mode: 'terminal', activeKey: 'file:d.ts' })
  })

  it('keeps diff tabs in the shared list without making them dirty or persistent', async () => {
    const memory = memoryPersistence()
    const store = new OpenFilesStore(memory.persistence, 0)
    const entry: WorkingTreeEntry = {
      key: 'unstaged:a.ts',
      area: 'unstaged',
      entry: {
        path: 'a.ts',
        oldPath: null,
        code: ' M',
        area: 'unstaged',
        status: 'modified'
      },
      added: 1,
      removed: 0
    }
    store.openDiff('ses_a', { kind: 'working', entry })
    store.openDiff('ses_a', { kind: 'working', entry })
    expect(store.get('ses_a').tabs).toHaveLength(1)
    expect(store.get('ses_a')).toMatchObject({ mode: 'editor', activePath: null })
    expect(store.dirtySummary()).toEqual({ files: 0, sessions: 0 })

    store.open('ses_a', 'b.ts')
    await store.flush()
    const second = new OpenFilesStore(memory.persistence, 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fileTabs(second.get('ses_a')).map((tab) => tab.path)).toEqual(['b.ts'])
    expect(second.get('ses_a').tabs).toHaveLength(1)
  })

  it('closes file and diff tabs under a renamed or deleted path', () => {
    const store = new OpenFilesStore()
    const entry: WorkingTreeEntry = {
      key: 'unstaged:src/a.ts',
      area: 'unstaged',
      entry: {
        path: 'src/a.ts',
        oldPath: null,
        code: ' M',
        area: 'unstaged',
        status: 'modified'
      },
      added: 1,
      removed: 0
    }
    store.open('ses_a', 'src/a.ts')
    store.openDiff('ses_a', { kind: 'working', entry })
    store.renamePath('ses_a', 'src', 'lib')
    expect(store.get('ses_a').tabs).toHaveLength(1)
    expect(store.find('ses_a', 'lib/a.ts')?.path).toBe('lib/a.ts')

    store.closeTabsUnder('ses_a', 'lib')
    expect(store.get('ses_a')).toMatchObject({
      tabs: [],
      activeKey: null,
      mode: 'terminal'
    })
  })

  it('restores the center mode but never restores a preview tab', () => {
    const parsed = parsePersistedOpenFiles({
      version: 1,
      sessions: {
        ses_a: {
          tabs: [
            {
              kind: 'file',
              preview: true,
              path: 'a.ts',
              text: 'a',
              savedText: 'a',
              original: null,
              etag: null,
              disk: 'current',
              load: 'ready',
              failure: null
            }
          ],
          activeKey: 'a.ts',
          activePath: 'a.ts',
          mode: 'terminal'
        }
      }
    })
    expect(parsed.get('ses_a')).toMatchObject({
      mode: 'terminal',
      activeKey: 'file:a.ts'
    })
    expect(parsed.get('ses_a')?.tabs[0]).toMatchObject({ preview: false, kind: 'file' })
  })

  it('reconciles session tabs, hides without stopping, and reopens', () => {
    const store = new OpenFilesStore()
    store.syncSessions('default:repo_1', ['ses_a', 'ses_b'])
    expect(sessionTabs(store.get('default:repo_1')).map((tab) => tab.sessionId)).toEqual([
      'ses_a',
      'ses_b'
    ])

    store.hideSession('default:repo_1', 'ses_a')
    expect(sessionTabs(store.get('default:repo_1')).map((tab) => tab.sessionId)).toEqual([
      'ses_b'
    ])
    expect(store.get('default:repo_1').hiddenSessionIds).toEqual(['ses_a'])

    store.showSession('default:repo_1', 'ses_a')
    expect(sessionTabs(store.get('default:repo_1')).map((tab) => tab.sessionId)).toEqual([
      'ses_b',
      'ses_a'
    ])
    expect(store.get('default:repo_1').activeKey).toBe('session:ses_a')

    store.removeSession('default:repo_1', 'ses_b')
    expect(sessionTabs(store.get('default:repo_1')).map((tab) => tab.sessionId)).toEqual([
      'ses_a'
    ])
  })

  it('keeps session and file tabs in one order', () => {
    const store = new OpenFilesStore()
    store.syncSessions('default:repo_1', ['ses_a'])
    store.open('default:repo_1', 'a.ts')
    store.syncSessions('default:repo_1', ['ses_a', 'ses_b'])
    expect(store.get('default:repo_1').tabs.map(tabKey)).toEqual([
      'session:ses_a',
      'file:a.ts',
      'session:ses_b'
    ])
  })

  it('migrates legacy session-keyed hot-exit state onto one workspace', async () => {
    const legacyTab = (path: string, text: string, savedText = text) => ({
      kind: 'file' as const,
      preview: false,
      path,
      text,
      savedText,
      original: null,
      etag: null,
      disk: 'current' as const,
      load: 'ready' as const,
      failure: null
    })
    const memory = memoryPersistence({
      'icode.files.tabs.v1': {
        version: 1,
        sessions: {
          ses_a: {
            tabs: [legacyTab('a.ts', 'saved')],
            activePath: 'a.ts',
            mode: 'editor'
          },
          ses_b: {
            tabs: [legacyTab('b.ts', 'b'), legacyTab('a.ts', 'dirty', 'saved')],
            activePath: 'b.ts',
            mode: 'editor'
          }
        }
      }
    })
    const store = new OpenFilesStore(memory.persistence, 0)
    await new Promise((resolve) => setTimeout(resolve, 0))

    await store.migrateLegacy({
      sessions: [
        { id: 'ses_a', repoId: 'repo_1', worktree: null },
        { id: 'ses_b', repoId: 'repo_1', worktree: null }
      ],
      taskSessionIds: new Set(),
      activeSessionId: 'ses_b'
    })

    const state = store.get('default:repo_1')
    expect(fileTabs(state).map((tab) => [tab.path, tab.text])).toEqual([
      ['a.ts', 'dirty'],
      ['b.ts', 'b']
    ])
    expect(state.activeKey).toBe('file:b.ts')
    expect(store.get('ses_a').tabs).toEqual([])
    expect(memory.read('icode.files.tabs.v2')).toBeTruthy()
  })
})
