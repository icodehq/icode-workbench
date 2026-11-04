import { describe, expect, it } from 'vitest'
import {
  reviewAreaDiffInputSchema,
  reviewDiffResultSchema,
  reviewPathSchema
} from './review'
import { REVIEW_MAX_FILE_BYTES } from '../domain/review'
import { newSessionId } from '../domain/ids'

const sessionId = newSessionId()

describe('review path rules', () => {
  it('accepts ordinary worktree-relative paths', () => {
    for (const path of [
      'src/app.ts',
      'README.md',
      'dir with space/file name.txt',
      'nested/deeper/file.ts',
      'unicode-✓.txt',
      '.gitignore',
      'a-b_c.d'
    ]) {
      expect(reviewPathSchema.safeParse(path).success).toBe(true)
    }
  })

  it('rejects absolute, drive, UNC, parent and option-like paths', () => {
    for (const path of [
      '/etc/passwd',
      '/tmp/x',
      'C:\\Windows\\win.ini',
      'C:/Windows',
      '\\\\server\\share',
      '../outside',
      'src/../../outside',
      'src/..',
      '..',
      '-p',
      '--output=/tmp/x',
      ''
    ]) {
      expect(reviewPathSchema.safeParse(path).success).toBe(false)
    }
  })

  it('rejects NUL and over-long paths', () => {
    expect(reviewPathSchema.safeParse('src/app\u0000.ts').success).toBe(false)
    expect(reviewPathSchema.safeParse('a'.repeat(4097)).success).toBe(false)
  })
})

describe('working-tree diff requests', () => {
  const base = {
    sessionId,
    path: 'src/app.ts',
    oldPath: null,
    scope: 'unstaged' as const,
    status: 'modified' as const,
    binary: false,
    symlink: false,
    additions: 1,
    deletions: 0
  }

  it('accepts each area scope and strictly rejects extras', () => {
    for (const scope of ['staged', 'unstaged', 'untracked']) {
      expect(reviewAreaDiffInputSchema.safeParse({ ...base, scope }).success).toBe(true)
    }
    expect(reviewAreaDiffInputSchema.safeParse({ ...base, path: '../a.ts' }).success).toBe(false)
    expect(reviewAreaDiffInputSchema.safeParse({ ...base, scope: 'committed' }).success).toBe(false)
    expect(reviewAreaDiffInputSchema.safeParse({ ...base, cwd: '/tmp' }).success).toBe(false)
  })
})

describe('review diff payloads', () => {
  it('validates a diff payload and its truncation contract', () => {
    const base = {
      status: 'available',
      sessionId,
      path: 'src/app.ts',
      oldPath: null,
      fileStatus: 'modified',
      patch: 'diff --git a/x b/x\n',
      truncated: false,
      truncatedReason: null,
      binary: false,
      symlink: false,
      additions: 1,
      deletions: 0
    }
    expect(reviewDiffResultSchema.safeParse(base).success).toBe(true)
    expect(
      reviewDiffResultSchema.safeParse({
        ...base,
        truncated: true,
        truncatedReason: 'bytes'
      }).success
    ).toBe(true)
    expect(
      reviewDiffResultSchema.safeParse({ ...base, truncated: true, truncatedReason: null }).success
    ).toBe(true)
    expect(reviewDiffResultSchema.safeParse({ ...base, truncatedReason: 'entries' }).success).toBe(
      false
    )
    expect(
      reviewDiffResultSchema.safeParse({
        ...base,
        patch: 'x'.repeat(REVIEW_MAX_FILE_BYTES + 65 * 1024)
      }).success
    ).toBe(false)
  })

  it('accepts the unavailable result shape', () => {
    expect(
      reviewDiffResultSchema.safeParse({
        status: 'unavailable',
        reason: 'primary-checkout',
        detail: 'This session runs in the primary checkout.'
      }).success
    ).toBe(true)
    expect(
      reviewDiffResultSchema.safeParse({
        status: 'unavailable',
        reason: 'made-up',
        detail: 'nope'
      }).success
    ).toBe(false)
  })
})
