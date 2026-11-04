export type BlameLine = {
  /** 1-based line in the final (working-tree) file. */
  line: number
  oid: string
  author: string
  authorTime: number
  summary: string
  /** False for uncommitted working-tree lines (zero object id). */
  committed: boolean
}

const HEADER = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/u

/**
 * Parses `git blame --line-porcelain`.
 *
 * `--line-porcelain` repeats commit metadata for every line, so the parser can
 * read one record at a time. The file content line starts with a tab and is
 * ignored; the final line number and the metadata are what the editor needs.
 */
export function parseBlamePorcelain(output: string): BlameLine[] {
  const lines: BlameLine[] = []
  let current: {
    oid: string
    finalLine: number
    author: string
    authorTime: number
    summary: string
  } | null = null

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/u, '')
    const header = HEADER.exec(line)
    if (header !== null) {
      current = {
        oid: header[1]!,
        finalLine: Number.parseInt(header[2]!, 10),
        author: '',
        authorTime: 0,
        summary: ''
      }
      continue
    }
    if (current === null) continue
    if (line.startsWith('\t')) {
      const oid = current.oid
      const finalLine = current.finalLine
      if (Number.isFinite(finalLine) && finalLine > 0) {
        lines.push({
          line: finalLine,
          oid,
          author: current.author.length > 0 ? current.author : 'Unknown',
          authorTime: current.authorTime,
          summary: current.summary,
          committed: !/^0+$/u.test(oid)
        })
      }
      current = null
      continue
    }
    if (line.startsWith('author ')) current.author = line.slice('author '.length)
    else if (line.startsWith('author-time ')) {
      const seconds = Number.parseInt(line.slice('author-time '.length), 10)
      current.authorTime = Number.isFinite(seconds) ? seconds : 0
    } else if (line.startsWith('summary ')) current.summary = line.slice('summary '.length)
  }
  return lines.sort((left, right) => left.line - right.line)
}
