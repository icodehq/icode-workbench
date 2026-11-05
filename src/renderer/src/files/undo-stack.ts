/**
 * Per-session undo entries for Files operations.
 *
 * The model is deliberately dumb: the FilesPanel performs the inverse through
 * the normal IPC and only pops an entry after the inverse succeeds. Keeping the
 * list immutable makes a stale or conflicting undo harmless to re-render.
 */

export type FileUndoEntry =
  | { kind: 'create'; path: string; etag: string | null; at: number }
  | { kind: 'rename'; from: string; to: string; at: number }
  | { kind: 'move'; pairs: Array<{ from: string; to: string }>; at: number }
  | {
      kind: 'copy'
      created: Array<{ path: string; etag: string | null }>
      at: number
    }
  | { kind: 'delete'; opId: string; paths: string[]; at: number }

export const UNDO_LIMIT = 20

export function pushUndo(
  stack: readonly FileUndoEntry[],
  entry: FileUndoEntry,
  limit = UNDO_LIMIT
): FileUndoEntry[] {
  return [entry, ...stack].slice(0, Math.max(1, limit))
}

export function peekUndo(stack: readonly FileUndoEntry[]): FileUndoEntry | null {
  return stack[0] ?? null
}

export function popUndo(stack: readonly FileUndoEntry[]): FileUndoEntry[] {
  return stack.slice(1)
}

/** Button/notice text; paths are named only when the label stays short. */
export function undoLabel(entry: FileUndoEntry | null): string {
  switch (entry?.kind) {
    case 'create':
      return `Undo create ${entry.path}`
    case 'rename':
      return `Undo rename ${entry.from}`
    case 'move':
      return `Undo move of ${String(entry.pairs.length)} item${entry.pairs.length === 1 ? '' : 's'}`
    case 'copy':
      return `Undo copy of ${String(entry.created.length)} item${entry.created.length === 1 ? '' : 's'}`
    case 'delete':
      return `Undo delete of ${String(entry.paths.length)} item${entry.paths.length === 1 ? '' : 's'}`
    default:
      return 'Nothing to undo'
  }
}
