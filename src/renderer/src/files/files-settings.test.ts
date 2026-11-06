import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILES_SETTINGS,
  FILES_SETTINGS_STORAGE_KEY,
  loadFilesSettings,
  saveFilesSettings,
  updateFilesSettings
} from './files-settings'

function storage(initial: string | null = null) {
  let value = initial
  return {
    getItem: (key: string) => (key === FILES_SETTINGS_STORAGE_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === FILES_SETTINGS_STORAGE_KEY) value = next
    }
  }
}

describe('files settings', () => {
  it('uses the documented defaults and hides only OS noise', () => {
    expect(DEFAULT_FILES_SETTINGS).toMatchObject({
      sortOrder: 'name',
      sortDirection: 'asc',
      compactFolders: true,
      fileNesting: false,
      gitDecorations: true,
      autoReveal: true,
      exclude: ['.DS_Store', 'Thumbs.db'],
      excludeGitIgnore: false,
      useTrash: true
    })
  })

  it('round-trips and merges patches', () => {
    const store = storage()
    const next = updateFilesSettings(
      DEFAULT_FILES_SETTINGS,
      { sortOrder: 'modified', compactFolders: false, exclude: ['*.log'] },
      store
    )
    expect(loadFilesSettings(store)).toEqual(next)
    expect(next.sortOrder).toBe('modified')
    expect(next.exclude).toEqual(['*.log'])
  })

  it('falls back on malformed storage', () => {
    expect(loadFilesSettings(storage('{'))).toEqual(DEFAULT_FILES_SETTINGS)
    expect(loadFilesSettings(storage('[]'))).toEqual(DEFAULT_FILES_SETTINGS)
    expect(
      loadFilesSettings(storage(JSON.stringify({ sortOrder: 'nope', exclude: [1] })))
    ).toEqual(DEFAULT_FILES_SETTINGS)
  })

  it('reports a failed save without throwing', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(saveFilesSettings(DEFAULT_FILES_SETTINGS, failing)).toBe(false)
  })
})
