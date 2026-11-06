import { describe, expect, it } from 'vitest'
import { checkEntryName, nameSelectionRange } from './name-validation'

describe('entry name validation', () => {
  it('rejects empty, whitespace, separators and dot names', () => {
    expect(checkEntryName('').error).toContain('required')
    expect(checkEntryName('   ').error).toContain('whitespace')
    expect(checkEntryName('a/b').error).toContain('path separators')
    expect(checkEntryName('a\\b').error).toContain('path separators')
    expect(checkEntryName('.').error).not.toBeNull()
    expect(checkEntryName('..').error).not.toBeNull()
  })

  it('rejects an existing sibling but allows the current name during rename', () => {
    expect(checkEntryName('a.ts', { siblings: ['a.ts'] }).error).toContain('already exists')
    expect(
      checkEntryName('a.ts', { siblings: ['a.ts'], previousName: 'a.ts' }).error
    ).toBeNull()
  })

  it('warns about leading or trailing whitespace', () => {
    const result = checkEntryName(' a.ts')
    expect(result.error).toBeNull()
    expect(result.warning).toContain('whitespace')
  })

  it('selects the basename but keeps the extension for files', () => {
    expect(nameSelectionRange('session.ts', false)).toEqual([0, 7])
    expect(nameSelectionRange('.env', false)).toEqual([0, 4])
    expect(nameSelectionRange('folder', true)).toEqual([0, 6])
  })
})
