import { describe, expect, it } from 'vitest'
import { splitStashPatch } from './stash-patch'

const PATCH = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1 +1 @@',
  '-one',
  '+ONE',
  'diff --git a/new file.txt b/new file.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new file.txt',
  '@@ -0,0 +1 @@',
  '+new',
  'diff --git a/old.txt b/moved.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to moved.txt',
  'diff --git a/image.png b/image.png',
  'index 1111111..2222222 100644',
  'Binary files a/image.png and b/image.png differ',
  ''
].join('\n')

describe('splitStashPatch', () => {
  it('splits files and reads status, paths and binary flags', () => {
    const files = splitStashPatch(PATCH)
    expect(files.map((file) => [file.path, file.status, file.binary])).toEqual([
      ['a.txt', 'modified', false],
      ['new file.txt', 'added', false],
      ['moved.txt', 'renamed', false],
      ['image.png', 'modified', true]
    ])
    expect(files[2]?.oldPath).toBe('old.txt')
    expect(files[0]?.patch).toContain('+ONE')
    expect(files[0]?.patch).not.toContain('new file.txt')
  })

  it('returns nothing for an empty or headerless patch', () => {
    expect(splitStashPatch('')).toEqual([])
    expect(splitStashPatch('not a patch\n')).toEqual([])
  })
})
