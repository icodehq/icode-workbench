import { describe, expect, it } from 'vitest'
import { shouldSkipIndexEntry } from './file-index'

describe('file index skips', () => {
  it('keeps the worktree .git file out of search', () => {
    expect(shouldSkipIndexEntry('.git', '.git')).toBe(true)
  })

  it('skips dependency and build directories', () => {
    expect(shouldSkipIndexEntry('node_modules', 'node_modules')).toBe(true)
    expect(shouldSkipIndexEntry('dist', 'packages/app/dist')).toBe(true)
  })

  it('does not hide ordinary hidden files or source paths', () => {
    expect(shouldSkipIndexEntry('.env', '.env')).toBe(false)
    expect(shouldSkipIndexEntry('app.ts', 'src/app.ts')).toBe(false)
  })
})
