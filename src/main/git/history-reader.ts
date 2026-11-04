import {
  GIT_EMPTY_TREE_OID,
  type GitLogEntry
} from '../../shared/domain/git-workspace'

/** git log record/field separators; neither can appear in a commit subject. */
const RECORD_SEPARATOR = '\u001e'
const FIELD_SEPARATOR = '\u001f'

export const LOG_PRETTY_FORMAT =
  `%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}` +
  `%ae${FIELD_SEPARATOR}%at${FIELD_SEPARATOR}%D${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`

/** The commit hash Git uses as the empty tree, for a root commit's diff. */
export const EMPTY_TREE_OID = GIT_EMPTY_TREE_OID

/**
 * Parses the `--pretty=format` output used by `git log`.
 *
 * Commits are delimited by U+001E and fields by U+001F. Git writes its own
 * newline between records, which is stripped before parsing. `%P` is a
 * space-separated parent list; the renderer needs the full hashes to build
 * graph lanes.
 */
export function parseLogOutput(output: string): GitLogEntry[] {
  const entries: GitLogEntry[] = []
  for (const raw of output.split(RECORD_SEPARATOR)) {
    const record = raw.replace(/^\r?\n/, '')
    if (record.length === 0) continue
    const [oid = '', shortOid = '', parents = '', author = '', authorEmail = '', authoredAt = '', refs = '', subject = ''] =
      record.split(FIELD_SEPARATOR)
    if (oid.length === 0) continue
    const authoredAtSeconds = Number.parseInt(authoredAt, 10)
    entries.push({
      oid,
      shortOid: shortOid || oid.slice(0, 7),
      parents: parents.length > 0 ? parents.split(' ').filter((parent) => parent.length > 0) : [],
      author,
      authorEmail,
      authoredAt: Number.isFinite(authoredAtSeconds) ? authoredAtSeconds : 0,
      refs:
        refs.length > 0
          ? refs
              .split(',')
              .map((ref) => ref.trim())
              .filter((ref) => ref.length > 0)
          : [],
      subject
    })
  }
  return entries
}

export type CommitMetadata = {
  oid: string
  shortOid: string
  parents: string[]
  author: string
  authorEmail: string
  authoredAt: number
  subject: string
  body: string
}

/**
 * Parses `git show -s --format=%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%B`.
 *
 * The body is the last field and may contain newlines, so it is the remainder
 * after the seventh NUL rather than a plain split assignment.
 */
export function parseCommitMetadata(output: string): CommitMetadata | null {
  const fields = output.split('\u0000')
  if (fields.length < 8) return null
  const [oid = '', shortOid = '', parents = '', author = '', authorEmail = '', authoredAt = '', subject = ''] =
    fields
  const body = fields.slice(7).join('\u0000').replace(/\s+$/, '')
  if (oid.length === 0) return null
  const authoredAtSeconds = Number.parseInt(authoredAt, 10)
  return {
    oid,
    shortOid: shortOid || oid.slice(0, 7),
    parents: parents.length > 0 ? parents.split(' ').filter((parent) => parent.length > 0) : [],
    author,
    authorEmail,
    authoredAt: Number.isFinite(authoredAtSeconds) ? authoredAtSeconds : 0,
    subject,
    body
  }
}
