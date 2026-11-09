import { translate } from '../i18n/i18n-store'
import type {
  GitStatusEntry,
  GitWorkspaceStatus
} from '../../../shared/domain/git-workspace'

export type FileDecoration = {
  letter: string
  /** Existing app tone token: text-add / text-signal / text-info / text-destructive. */
  tone: string
  title: string
}

export type FileDecorations = {
  files: Map<string, FileDecoration>
  /** Folders with at least one decorated descendant. */
  folders: Set<string>
}

const EMPTY: FileDecorations = { files: new Map(), folders: new Set() }

function decorationFor(entry: GitStatusEntry): FileDecoration {
  switch (entry.status) {
    case 'added':
      return { letter: 'A', tone: 'text-add', title: translate('fileDecoration.added') }
    case 'untracked':
      return { letter: 'U', tone: 'text-add', title: translate('fileDecoration.untracked') }
    case 'deleted':
      return { letter: 'D', tone: 'text-destructive', title: translate('fileDecoration.deleted') }
    case 'renamed':
      return { letter: 'R', tone: 'text-info', title: translate('fileDecoration.renamed') }
    case 'copied':
      return { letter: 'C', tone: 'text-info', title: translate('fileDecoration.copied') }
    case 'unmerged':
      return { letter: '!', tone: 'text-destructive', title: translate('fileDecoration.conflict') }
    default:
      return { letter: 'M', tone: 'text-signal', title: translate('fileDecoration.modified') }
  }
}

function ancestorsOf(path: string): string[] {
  const segments = path.split('/')
  const result: string[] = []
  let prefix = ''
  for (let index = 0; index < segments.length - 1; index += 1) {
    prefix = prefix === '' ? (segments[index] ?? '') : `${prefix}/${segments[index] ?? ''}`
    result.push(prefix)
  }
  return result
}

/**
 * Decorates file paths and their ancestor folders from one Git snapshot.
 *
 * Precedence follows what the user edits: conflict, then untracked, then the
 * worktree state, then the index. A partially staged file therefore shows the
 * unstaged `M` it still has in the editor.
 */
export function buildFileDecorations(snapshot: GitWorkspaceStatus | null): FileDecorations {
  if (snapshot === null) return EMPTY
  const files = new Map<string, FileDecoration>()
  const apply = (entries: readonly GitStatusEntry[]): void => {
    for (const entry of entries) files.set(entry.path, decorationFor(entry))
  }
  apply(snapshot.staged)
  apply(snapshot.unstaged)
  apply(snapshot.untracked)
  apply(snapshot.conflicted)

  const folders = new Set<string>()
  for (const path of files.keys()) {
    for (const ancestor of ancestorsOf(path)) folders.add(ancestor)
  }
  return { files, folders }
}
