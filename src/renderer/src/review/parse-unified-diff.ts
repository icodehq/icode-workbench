/**
 * Unified-diff parsing for read-only review.
 *
 * The parser keeps source content intact: only Git's structural metadata lines
 * are dropped, and a trailing CR is recorded per line rather than merged into
 * the text. Rendering may normalise presentation, never content.
 */

export type DiffLineKind = 'context' | 'add' | 'remove' | 'meta'

export type DiffLine = {
  kind: DiffLineKind
  /** Content without the leading marker and without a trailing CR. */
  text: string
  /** True when the source line ended with CRLF. */
  crlf: boolean
  oldLine: number | null
  newLine: number | null
}

export type DiffHunk = {
  header: string
  section: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export type ParsedDiff = {
  hunks: DiffHunk[]
  /** `Binary files … differ` with no textual hunks. */
  binary: boolean
  /** Patch ended with `\ No newline at end of file`. */
  noNewlineAtEof: boolean
  oldPath: string | null
  newPath: string | null
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/u

const METADATA_PREFIXES = [
  'diff --git ',
  'index ',
  '--- ',
  '+++ ',
  'new file mode ',
  'deleted file mode ',
  'old mode ',
  'new mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to '
]

function stripPrefix(value: string): string {
  return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value
}

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const result: ParsedDiff = {
    hunks: [],
    binary: false,
    noNewlineAtEof: false,
    oldPath: null,
    newPath: null
  }
  if (patch.trim().length === 0) return result

  const rawLines = patch.split('\n')
  // A trailing newline produces an empty final element that is not a line.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop()

  let current: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const raw of rawLines) {
    if (raw.startsWith('Binary files ') && raw.endsWith(' differ')) {
      result.binary = true
      current = null
      continue
    }
    if (raw.startsWith('\\')) {
      result.noNewlineAtEof = true
      if (current) {
        current.lines.push({
          kind: 'meta',
          text: raw,
          crlf: false,
          oldLine: null,
          newLine: null
        })
      }
      continue
    }
    if (raw.startsWith('diff --git ')) {
      current = null
      continue
    }
    if (raw.startsWith('--- ')) {
      const value = raw.slice(4).trim()
      result.oldPath = value === '/dev/null' ? null : stripPrefix(value)
      continue
    }
    if (raw.startsWith('+++ ')) {
      const value = raw.slice(4).trim()
      result.newPath = value === '/dev/null' ? null : stripPrefix(value)
      continue
    }

    const match = HUNK_HEADER.exec(raw)
    if (match) {
      const oldStart = Number(match[1])
      const oldCount = match[2] === undefined ? 1 : Number(match[2])
      const newStart = Number(match[3])
      const newCount = match[4] === undefined ? 1 : Number(match[4])
      current = {
        header: raw,
        section: match[5] ?? '',
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: []
      }
      result.hunks.push(current)
      oldLine = oldStart
      newLine = newStart
      continue
    }

    if (current === null) continue
    if (METADATA_PREFIXES.some((prefix) => raw.startsWith(prefix))) continue
    if (raw.length === 0) continue

    const marker = raw.charAt(0)
    if (marker !== ' ' && marker !== '+' && marker !== '-') continue

    let text = raw.slice(1)
    const crlf = text.endsWith('\r')
    if (crlf) text = text.slice(0, -1)

    if (marker === ' ') {
      current.lines.push({ kind: 'context', text, crlf, oldLine, newLine })
      oldLine += 1
      newLine += 1
    } else if (marker === '+') {
      current.lines.push({ kind: 'add', text, crlf, oldLine: null, newLine })
      newLine += 1
    } else {
      current.lines.push({ kind: 'remove', text, crlf, oldLine, newLine: null })
      oldLine += 1
    }
  }

  return result
}

export type DiffRow =
  | { kind: 'line'; line: DiffLine }
  | { kind: 'collapsed'; count: number; lines: DiffLine[]; id: string }

/**
 * Collapses long unchanged runs for presentation. Collapsed lines are still in
 * the model; expanding renders them exactly as parsed.
 */
export function collapseContext(
  hunk: DiffHunk,
  contextLines = 2,
  hunkIndex = 0
): DiffRow[] {
  const rows: DiffRow[] = []
  let run: DiffLine[] = []

  const flush = (): void => {
    if (run.length > contextLines * 2 + 1) {
      rows.push(row('line', run[0]!))
      const middle = run.slice(1, run.length - 1)
      rows.push({
        kind: 'collapsed',
        count: middle.length,
        lines: middle,
        id: `${String(hunkIndex)}:${String(middle[0]?.oldLine ?? 0)}`
      })
      rows.push(row('line', run[run.length - 1]!))
    } else {
      for (const line of run) rows.push(row('line', line))
    }
    run = []
  }

  for (const line of hunk.lines) {
    if (line.kind === 'context') {
      run.push(line)
      continue
    }
    if (run.length > 0) flush()
    rows.push(row('line', line))
  }
  if (run.length > 0) flush()
  return rows

  function row(_kind: 'line', line: DiffLine): DiffRow {
    return { kind: 'line', line }
  }
}
