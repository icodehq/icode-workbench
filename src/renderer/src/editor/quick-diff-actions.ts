import { buildLinePatch, lineSelectionKey, splitPatchHunks } from '../review/hunk-patch'
import { parseUnifiedDiff } from '../review/parse-unified-diff'
import type { LineChange } from './line-diff'

export type QuickDiffPatchResult =
  | { status: 'ok'; patch: string }
  | { status: 'error'; error: string }

/** Index of the quick-diff change containing a 1-based modified-file line. */
export function quickChangeForLine(changes: readonly LineChange[], line: number): number | null {
  for (const [index, change] of changes.entries()) {
    if (change.newCount > 0) {
      if (line >= change.newStart && line < change.newStart + change.newCount) return index
      continue
    }
    if (line === change.newAnchor) return index
  }
  return null
}

function inRange(range: readonly [number, number] | null, line: number): boolean {
  return range !== null && line >= range[0] && line <= range[1]
}

function overlaps(
  left: readonly [number, number] | null,
  right: readonly [number, number]
): boolean {
  return left !== null && left[0] <= right[1] && right[0] <= left[1]
}

/**
 * Builds one patch for a quick-diff change from the saved Git diff.
 *
 * The Files quick diff and Git can group nearby edits differently, so the
 * change's old/new line ranges select the intersecting changed lines inside
 * each Git hunk. Several Git hunks are combined under the original file
 * header, which keeps `git apply` atomic: one stale hunk rejects the whole
 * action instead of leaving half the change behind.
 *
 * Only call this when the file has no staged changes; otherwise the index is
 * not the HEAD baseline the quick diff was computed against.
 */
export function quickDiffPatch(
  gitPatch: string,
  change: LineChange,
  direction: 'forward' | 'reverse'
): QuickDiffPatchResult {
  const parsed = parseUnifiedDiff(gitPatch)
  if (parsed.hunks.length === 0) {
    return { status: 'error', error: 'Git reports no unstaged changes for this file.' }
  }
  const oldRange: [number, number] | null =
    change.oldCount > 0 ? [change.oldStart, change.oldStart + change.oldCount - 1] : null
  const newRange: [number, number] | null =
    change.newCount > 0 ? [change.newStart, change.newStart + change.newCount - 1] : null
  const header = splitPatchHunks(gitPatch).header
  const bodies: string[] = []
  for (const [index, hunk] of parsed.hunks.entries()) {
    const hunkOld: [number, number] =
      hunk.oldCount > 0 ? [hunk.oldStart, hunk.oldStart + hunk.oldCount - 1] : [hunk.oldStart, hunk.oldStart]
    const hunkNew: [number, number] =
      hunk.newCount > 0 ? [hunk.newStart, hunk.newStart + hunk.newCount - 1] : [hunk.newStart, hunk.newStart]
    if (!overlaps(oldRange, hunkOld) && !overlaps(newRange, hunkNew)) continue
    const selected = new Set<string>()
    for (const line of hunk.lines) {
      if (line.kind === 'remove' && line.oldLine !== null && inRange(oldRange, line.oldLine)) {
        selected.add(lineSelectionKey('old', line.oldLine))
      } else if (line.kind === 'add' && line.newLine !== null && inRange(newRange, line.newLine)) {
        selected.add(lineSelectionKey('new', line.newLine))
      }
    }
    if (selected.size === 0) continue
    const built = buildLinePatch(gitPatch, index, selected, direction)
    if (built.status === 'error') return built
    const start = built.patch.startsWith('@@ ')
      ? 0
      : built.patch.indexOf('\n@@ ') + 1
    if (start < 0) {
      return { status: 'error', error: 'The selected change could not be turned into a hunk.' }
    }
    bodies.push(built.patch.slice(start).replace(/\n$/u, ''))
  }
  if (bodies.length === 0) {
    return { status: 'error', error: 'No Git changed lines match the selected quick-diff change.' }
  }
  const combined = header.length > 0 ? `${header}\n${bodies.join('\n')}` : bodies.join('\n')
  return { status: 'ok', patch: combined.endsWith('\n') ? combined : `${combined}\n` }
}
