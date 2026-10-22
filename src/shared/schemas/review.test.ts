import { describe, expect, it } from 'vitest'
import {
  reviewDiffInputSchema,
  reviewDiffResultSchema,
  reviewFileSchema,
  reviewListInputSchema,
  reviewListResultSchema,
  reviewPathSchema
} from './review'
import { REVIEW_MAX_FILES, REVIEW_MAX_FILE_BYTES } from '../domain/review'
import { newSessionId } from '../domain/ids'

const sessionId = newSessionId()

function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'src/app.ts',
    oldPath: null,
    status: 'modified',
    area: 'unstaged',
    origin: 'tracked',
    additions: 2,
    deletions: 1,
    binary: false,
    symlink: false,
    ...overrides
  }
}

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

describe('review requests', () => {
  it('requires a session ID and validates diff input', () => {
    expect(reviewListInputSchema.safeParse({ sessionId }).success).toBe(true)
    expect(reviewListInputSchema.safeParse({}).success).toBe(false)
    expect(reviewDiffInputSchema.safeParse({ sessionId, path: 'a.ts' }).success).toBe(true)
    expect(
      reviewDiffInputSchema.safeParse({ sessionId, path: 'a.ts', oldPath: 'old.ts' }).success
    ).toBe(true)
    expect(reviewDiffInputSchema.safeParse({ sessionId, path: '../a.ts' }).success).toBe(false)
    expect(
      reviewDiffInputSchema.safeParse({ sessionId, path: 'a.ts', cwd: '/tmp' }).success
    ).toBe(false)
  })
})

describe('review payloads', () => {
  it('validates file rows and stays strict about unknown fields', () => {
    expect(reviewFileSchema.safeParse(file()).success).toBe(true)
    expect(reviewFileSchema.safeParse(file({ status: 'copied' })).success).toBe(false)
    expect(reviewFileSchema.safeParse(file({ area: 'staged-only' })).success).toBe(false)
    expect(reviewFileSchema.safeParse(file({ extra: true })).success).toBe(false)
    expect(reviewFileSchema.safeParse(file({ additions: null, binary: true })).success).toBe(true)
  })

  it('accepts an available list and an unavailable result', () => {
    expect(
      reviewListResultSchema.safeParse({
        status: 'available',
        sessionId,
        baselineOid: 'a'.repeat(40),
        files: [file()],
        listTruncated: false
      }).success
    ).toBe(true)
    expect(
      reviewListResultSchema.safeParse({
        status: 'unavailable',
        reason: 'primary-checkout',
        detail: 'This session runs in the primary checkout.'
      }).success
    ).toBe(true)
    expect(
      reviewListResultSchema.safeParse({
        status: 'unavailable',
        reason: 'made-up',
        detail: 'nope'
      }).success
    ).toBe(false)
  })

  it('bounds the file list at the documented cap', () => {
    const many = Array.from({ length: REVIEW_MAX_FILES + 1 }, (_value, index) =>
      file({ path: `f${String(index)}.txt` })
    )
    const result = reviewListResultSchema.safeParse({
      status: 'available',
      sessionId,
      baselineOid: 'a'.repeat(40),
      files: many,
      listTruncated: false
    })
    expect(result.success).toBe(false)
  })

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
})
