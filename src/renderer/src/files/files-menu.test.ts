import { describe, expect, it } from 'vitest'
import { filesMenuEntries, type FilesMenuInput } from './files-menu'

const base: FilesMenuInput = {
  targetKind: 'file',
  pathCount: 1,
  canPaste: false,
  clipboardElsewhere: false,
  transferBusy: false,
  canOpenHistory: false
}

describe('files context menu', () => {
  it('offers file actions in order and separates management from rename/delete', () => {
    const entries = filesMenuEntries(base)
    expect(entries.map((entry) => entry.id)).toEqual([
      'open',
      'cut',
      'copy',
      'duplicate',
      'copy-path',
      'copy-relative-path',
      'rename',
      'delete'
    ])
    expect(entries.filter((entry) => entry.separatorBefore).map((entry) => entry.id))
      .toEqual(['cut', 'rename'])
    expect(entries.every((entry) => !entry.disabled)).toBe(true)
  })

  it('adds folder creation and paste, and root-only select-all/refresh', () => {
    const root = filesMenuEntries({
      ...base,
      targetKind: 'root',
      pathCount: 0,
      canPaste: true
    })
    expect(root.map((entry) => entry.id).slice(0, 4)).toEqual([
      'new-file',
      'new-folder',
      'paste',
      'cut'
    ])
    expect(root.slice(-2).map((entry) => entry.id)).toEqual(['select-all', 'refresh'])
    expect(root.find((entry) => entry.id === 'select-all')?.separatorBefore).toBe(true)
    expect(root.find((entry) => entry.id === 'refresh')?.separatorBefore).toBe(false)
  })

  it('distinguishes an empty clipboard from another session and a busy transfer', () => {
    const reasonFor = (input: Partial<FilesMenuInput>): string | undefined =>
      filesMenuEntries({ ...base, targetKind: 'directory', ...input })
        .find((entry) => entry.id === 'paste')?.reason

    expect(reasonFor({})).toBe('copy-first')
    expect(reasonFor({ clipboardElsewhere: true })).toBe('other-session')
    expect(reasonFor({ canPaste: true, transferBusy: true })).toBe('busy')
    expect(reasonFor({ canPaste: true })).toBeUndefined()
  })

  it('disables path actions with selection-specific reasons', () => {
    const entries = filesMenuEntries({ ...base, pathCount: 0 })
    const reason = (id: string): string | undefined =>
      entries.find((entry) => entry.id === id)?.reason

    expect(reason('cut')).toBe('select-cut')
    expect(reason('copy')).toBe('select-copy')
    expect(reason('duplicate')).toBe('select-duplicate')
    expect(reason('copy-path')).toBe('select-copy')
    expect(reason('copy-relative-path')).toBe('select-copy')
    expect(reason('rename')).toBe('select-one-rename')
    expect(reason('delete')).toBe('select-delete')
  })

  it('marks rename unavailable for a multi-selection and busy for all mutations', () => {
    const multi = filesMenuEntries({ ...base, pathCount: 2 })
    expect(multi.find((entry) => entry.id === 'rename')?.disabled).toBe(true)
    expect(multi.find((entry) => entry.id === 'delete')?.disabled).toBe(false)

    const busy = filesMenuEntries({ ...base, transferBusy: true })
    expect(busy.find((entry) => entry.id === 'duplicate')?.reason).toBe('busy')
    expect(busy.find((entry) => entry.id === 'rename')?.reason).toBe('busy')
    expect(busy.find((entry) => entry.id === 'delete')?.reason).toBe('busy')
  })

  it('adds the history entry with a separator when the target supports it', () => {
    const entries = filesMenuEntries({ ...base, canOpenHistory: true })
    const history = entries.find((entry) => entry.id === 'history')
    expect(history).toEqual({ id: 'history', separatorBefore: true, disabled: false })
  })
})
