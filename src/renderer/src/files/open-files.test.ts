import { describe, expect, it } from 'vitest'
import {
  FILES_MAX_BUFFERED_CHARS,
  OpenFilesStore,
  parsePersistedOpenFiles,
  type OpenFilesPersistence
} from './open-files'

function memoryPersistence(initial: unknown = null) {
  let value = initial
  const persistence: OpenFilesPersistence = {
    load: async () => value,
    save: async (next) => {
      value = next
    }
  }
  return { persistence, read: () => value }
}

describe('open files store', () => {
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
    expect(store.get('ses_a').tabs.map((tab) => tab.path)).toEqual(['one.ts', 'two.ts'])
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
    expect(store.allDirtyTabs().map((tab) => `${tab.sessionId}:${tab.path}`)).toEqual([
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
    expect(store.get('ses_a').tabs.map((tab) => tab.path)).toEqual([
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
    expect(second.get('ses_a').tabs.map((tab) => tab.path)).toEqual(['a.ts', 'b.ts'])
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
})
