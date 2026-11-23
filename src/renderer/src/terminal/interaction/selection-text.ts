/**
 * Clipboard text normalization for terminal selections.
 *
 * Terminal rows carry trailing blanks, and agent output is often painted behind
 * a common left gutter. Trimming only the indent every non-empty selected line
 * shares keeps intentional deeper indentation intact.
 */

export function trimTerminalSelection(text: string): string {
  if (text.length === 0) return text
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  const withoutTrailing = lines.map((line) => line.replace(/\s+$/u, ''))
  const finish = (next: string[]): string => next.join('\n').replace(/\n+$/u, '')
  const nonEmpty = withoutTrailing.filter((line) => line.trim().length > 0)
  if (nonEmpty.length < 2) return finish(withoutTrailing)

  let prefix = nonEmpty[0]!.match(/^\s*/u)?.[0] ?? ''
  for (const line of nonEmpty.slice(1)) {
    const indent = line.match(/^\s*/u)?.[0] ?? ''
    while (prefix.length > 0 && !indent.startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
    }
    if (prefix.length === 0) break
  }
  if (prefix.length === 0) return finish(withoutTrailing)
  return finish(
    withoutTrailing.map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
  )
}
