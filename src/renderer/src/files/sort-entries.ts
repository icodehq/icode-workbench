import type { FileEntry } from '../../../shared/domain/workspace-files'

export type EntrySortOptions = {
  order: 'name' | 'type' | 'modified'
  direction: 'asc' | 'desc'
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function nameCompare(left: FileEntry, right: FileEntry): number {
  const folded = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  return folded !== 0 ? folded : left.name.localeCompare(right.name)
}

export function compareFileEntries(
  left: FileEntry,
  right: FileEntry,
  options: EntrySortOptions
): number {
  // Folders stay grouped before files in both directions.
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1

  const direction = options.direction === 'asc' ? 1 : -1
  if (options.order === 'modified') {
    const leftTime = left.modifiedAt
    const rightTime = right.modifiedAt
    if (leftTime === null && rightTime === null) return nameCompare(left, right)
    // Entries without a timestamp sort last regardless of direction.
    if (leftTime === null) return 1
    if (rightTime === null) return -1
    const byTime = leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1
    return byTime === 0 ? nameCompare(left, right) : byTime * direction
  }
  if (options.order === 'type') {
    const byType = extensionOf(left.name).localeCompare(extensionOf(right.name))
    return (byType === 0 ? nameCompare(left, right) : byType) * direction
  }
  return nameCompare(left, right) * direction
}

export function sortFileEntries(
  entries: readonly FileEntry[],
  options: EntrySortOptions
): FileEntry[] {
  return [...entries].sort((left, right) => compareFileEntries(left, right, options))
}
