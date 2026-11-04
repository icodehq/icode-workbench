import type { ReviewFileStatus } from '../../../shared/domain/review'

export type StashPatchFile = {
  path: string
  oldPath: string | null
  status: ReviewFileStatus
  binary: boolean
  patch: string
}

function headerPath(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '/dev/null') return null
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
  return unquoted.startsWith('a/') || unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted
}

/**
 * Splits a stash patch into one block per file.
 *
 * `git stash show -p` emits ordinary unified patches with a `diff --git`
 * header per file. The file path comes from the `---`/`+++` lines rather than
 * the `diff --git` line because those remain unambiguous when a path contains
 * spaces. Binary and rename blocks keep their headers so the viewer can say
 * what it cannot render.
 */
export function splitStashPatch(patch: string): StashPatchFile[] {
  if (patch.trim().length === 0) return []
  const lines = patch.split('\n')
  const starts: number[] = []
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('diff --git ')) starts.push(index)
  }
  if (starts.length === 0) return []
  const files: StashPatchFile[] = []
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? lines.length
    const block = lines.slice(start, end).join('\n')
    const blockLines = block.split('\n')
    const plus = blockLines.find((line) => line.startsWith('+++ '))
    const minus = blockLines.find((line) => line.startsWith('--- '))
    const renameFrom = blockLines
      .find((line) => line.startsWith('rename from '))
      ?.slice('rename from '.length)
    const renameTo = blockLines
      .find((line) => line.startsWith('rename to '))
      ?.slice('rename to '.length)
    const header = blockLines.find((line) => line.startsWith('diff --git '))
    let headerOld: string | null = null
    let headerNew: string | null = null
    if (header !== undefined) {
      const rest = header.slice('diff --git '.length)
      const split = rest.indexOf(' b/')
      if (rest.startsWith('a/') && split > 2) {
        headerOld = rest.slice(2, split)
        headerNew = rest.slice(split + 3)
      }
    }
    const newPath =
      renameTo ??
      (plus === undefined ? headerNew : headerPath(plus.slice(4))) ??
      headerNew
    const oldPath =
      renameFrom ??
      (minus === undefined ? headerOld : headerPath(minus.slice(4))) ??
      headerOld
    const path = newPath ?? oldPath
    if (path === null) continue
    const status: ReviewFileStatus = blockLines.some((line) =>
      line.startsWith('new file mode ')
    )
      ? 'added'
      : blockLines.some((line) => line.startsWith('deleted file mode '))
        ? 'deleted'
        : blockLines.some((line) => line.startsWith('rename from '))
          ? 'renamed'
          : 'modified'
    files.push({
      path,
      oldPath: oldPath !== null && oldPath !== path ? oldPath : null,
      status,
      binary: block.includes('Binary files ') || block.includes('GIT binary patch'),
      patch: block
    })
  }
  return files
}
