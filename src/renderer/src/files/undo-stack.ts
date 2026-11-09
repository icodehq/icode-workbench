import { translate, translatePlural } from '../i18n/i18n-store'
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
      return translate('files.undoCreate', { path: entry.path })
    case 'rename':
      return translate('files.undoRename', { path: entry.from })
    case 'move':
      return translatePlural('files.undoMove', entry.pairs.length)
    case 'copy':
      return translatePlural('files.undoCopy', entry.created.length)
    case 'delete':
      return translatePlural('files.undoDelete', entry.paths.length)
    default:
      return translate('files.undoNothing')
  }
}
