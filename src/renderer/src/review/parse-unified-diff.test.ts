import { describe, expect, it } from 'vitest'
import { collapseContext, parseUnifiedDiff } from './parse-unified-diff'

const MODIFY = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ export function main()
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
 return a
`

describe('parseUnifiedDiff', () => {
  it('parses a modification with correct line mapping', () => {
    const parsed = parseUnifiedDiff(MODIFY)
    expect(parsed.hunks).toHaveLength(1)
    expect(parsed.oldPath).toBe('src/app.ts')
    expect(parsed.newPath).toBe('src/app.ts')
    const hunk = parsed.hunks[0]!
    expect(hunk).toMatchObject({ oldStart: 1, oldCount: 4, newStart: 1, newCount: 5 })
    expect(hunk.section).toBe('export function main()')

    const removed = hunk.lines.find((line) => line.kind === 'remove')
    const added = hunk.lines.filter((line) => line.kind === 'add')
    expect(removed).toMatchObject({ text: 'const b = 2', oldLine: 2, newLine: null })
    expect(added.map((line) => [line.text, line.newLine])).toEqual([
      ['const b = 3', 2],
      ['const c = 4', 3]
    ])
    // Line numbers advance independently on each side after the change.
    const after = hunk.lines.at(-1)!
    expect(after).toMatchObject({ kind: 'context', text: 'return a', oldLine: 4, newLine: 5 })
  })

  it('parses an added file with a /dev/null old side', () => {
    const parsed = parseUnifiedDiff(`diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`)
    expect(parsed.oldPath).toBeNull()
    expect(parsed.newPath).toBe('new.txt')
    expect(parsed.hunks[0]!.lines.map((line) => line.kind)).toEqual(['add', 'add'])
    expect(parsed.hunks[0]!.lines.map((line) => line.newLine)).toEqual([1, 2])
  })

  it('parses a deletion', () => {
    const parsed = parseUnifiedDiff(`diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`)
    expect(parsed.newPath).toBeNull()
    expect(parsed.hunks[0]!.lines).toHaveLength(2)
    expect(parsed.hunks[0]!.lines.every((line) => line.kind === 'remove')).toBe(true)
  })

  it('parses a rename with an edit', () => {
    const parsed = parseUnifiedDiff(`diff --git a/old.txt b/new.txt
similarity index 70%
rename from old.txt
rename to new.txt
index 111..222 100644
--- a/old.txt
+++ b/new.txt
@@ -1,2 +1,2 @@
 keep
-old
+new
`)
    expect(parsed.oldPath).toBe('old.txt')
    expect(parsed.newPath).toBe('new.txt')
    expect(parsed.hunks[0]!.lines.map((line) => line.kind)).toEqual(['context', 'remove', 'add'])
  })

  it('keeps conflict markers as content', () => {
    const parsed = parseUnifiedDiff(`diff --git a/f.txt b/f.txt
index 1..2 100644
--- a/f.txt
+++ b/f.txt
@@ -1 +1,5 @@
 a
+<<<<<<< HEAD
+MAIN
+=======
+SIDE
+>>>>>>> side
`)
    expect(parsed.hunks[0]!.lines.filter((line) => line.kind === 'add').map((line) => line.text)).toEqual([
      '<<<<<<< HEAD',
      'MAIN',
      '=======',
      'SIDE',
      '>>>>>>> side'
    ])
  })

  it('flags binary patches without inventing hunks', () => {
    const parsed = parseUnifiedDiff(`diff --git a/img.bin b/img.bin
index 111..222 100644
Binary files a/img.bin and b/img.bin differ
`)
    expect(parsed.binary).toBe(true)
    expect(parsed.hunks).toHaveLength(0)
  })

  it('preserves CRLF content and records the terminator', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/crlf.txt b/crlf.txt\n--- a/crlf.txt\n+++ b/crlf.txt\n@@ -1 +1 @@\n-old\r\n+new\r\n'
    )
    const [removed, added] = parsed.hunks[0]!.lines
    expect(removed).toMatchObject({ text: 'old', crlf: true })
    expect(added).toMatchObject({ text: 'new', crlf: true })
    expect(removed!.text).not.toContain('\r')
  })

  it('records the no-newline-at-EOF marker', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n'
    )
    expect(parsed.noNewlineAtEof).toBe(true)
    expect(parsed.hunks[0]!.lines.at(-1)?.kind).toBe('meta')
  })

  it('handles multiple hunks and hunk headers without counts', () => {
    const parsed = parseUnifiedDiff(`diff --git a/m.txt b/m.txt
--- a/m.txt
+++ b/m.txt
@@ -1 +1 @@
-a
+b
@@ -10,2 +10,2 @@ section
-c
+C
 d
`)
    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.hunks[1]).toMatchObject({ oldStart: 10, oldCount: 2, newStart: 10, newCount: 2 })
    expect(parsed.hunks[0]!.lines.map((line) => line.text)).toEqual(['a', 'b'])
  })

  it('returns an empty parse for an empty patch', () => {
    expect(parseUnifiedDiff('')).toEqual({
      hunks: [],
      binary: false,
      noNewlineAtEof: false,
      oldPath: null,
      newPath: null
    })
  })
})

describe('collapseContext', () => {
  it('collapses long unchanged runs but keeps every line reachable', () => {
    const lines = Array.from({ length: 12 }, (_value, index) => `line ${String(index)}`)
    const patch = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      `@@ -1,13 +1,13 @@`,
      ...lines.map((line) => ` ${line}`),
      '-old',
      '+new',
      ''
    ].join('\n')
    const parsed = parseUnifiedDiff(patch)
    const rows = collapseContext(parsed.hunks[0]!, 2)
    const collapsed = rows.filter((row) => row.kind === 'collapsed')
    expect(collapsed).toHaveLength(1)
    const marker = collapsed[0] as Extract<(typeof rows)[number], { kind: 'collapsed' }>
    expect(marker.count).toBe(10)
    expect(marker.lines).toHaveLength(10)
    expect(marker.lines[0]!.text).toBe('line 1')
    expect(rows.filter((row) => row.kind === 'line')).toHaveLength(4)
  })

  it('leaves short runs expanded', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n'
    )
    const rows = collapseContext(parsed.hunks[0]!)
    expect(rows.every((row) => row.kind === 'line')).toBe(true)
  })
})
