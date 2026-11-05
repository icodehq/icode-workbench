import type { GitStatusEntry } from '../../shared/domain/git-workspace'
import { STATUS_V2_ARGS, type ParsedRepositoryStatus } from './status-reader'

/** A commit message is one line of intent; blank messages are refused. */
export const MAX_MESSAGE_LENGTH = 4000

/** Patch cap shared by apply and revision diffs. */
export const MAX_PATCH_BYTES = 2 * 1024 * 1024 + 64 * 1024

export const STATUS_ARGS: string[] = [...STATUS_V2_ARGS]

type ParsedNameStatus = { path: string; oldPath: string | null; status: string }
export type ParsedNumstat = {
  path: string
  oldPath: string | null
  additions: number | null
  deletions: number | null
  binary: boolean
}

/** One flat list in the order the UI groups it. */
export function entriesOf(status: ParsedRepositoryStatus): GitStatusEntry[] {
  return [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted]
}

/**
 * `git diff --name-status -z` uses NUL-delimited records. A rename/copy record
 * has three fields (status, old path, new path); every other record has two.
 */
export function parseNameStatusZ(output: string): ParsedNameStatus[] {
  const fields = output.split('\u0000')
  const parsed: ParsedNameStatus[] = []
  let index = 0
  while (index < fields.length) {
    const status = fields[index++]
    if (!status) continue
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = fields[index++] ?? ''
      const path = fields[index++] ?? ''
      if (path.length > 0) parsed.push({ path, oldPath: oldPath || null, status: status[0]! })
      continue
    }
    const path = fields[index++] ?? ''
    if (path.length > 0) parsed.push({ path, oldPath: null, status: status[0]! })
  }
  return parsed
}

/** `--numstat -z` puts an empty path field before the two names of a rename. */
export function parseNumstatZ(output: string): ParsedNumstat[] {
  const fields = output.split('\u0000')
  const parsed: ParsedNumstat[] = []
  let index = 0
  while (index < fields.length) {
    const line = fields[index++]
    if (!line) continue
    const [rawAdd = '', rawDel = '', rawPath = ''] = line.split('\t')
    let oldPath: string | null = null
    let path = rawPath
    if (path.length === 0) {
      oldPath = fields[index++] ?? null
      path = fields[index++] ?? ''
    }
    if (path.length === 0) continue
    const binary = rawAdd === '-' || rawDel === '-'
    const additions = binary ? null : Number.parseInt(rawAdd, 10)
    const deletions = binary ? null : Number.parseInt(rawDel, 10)
    parsed.push({
      path,
      oldPath,
      additions: Number.isFinite(additions) ? additions : null,
      deletions: Number.isFinite(deletions) ? deletions : null,
      binary
    })
  }
  return parsed
}

export function detailOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return fallback
}

/**
 * Accepts exactly one plain-file patch whose paths match the selected file.
 *
 * `git apply --include` is a second boundary, but the patch is still checked
 * here so a renderer bug cannot smuggle a rename, copy, binary blob, submodule
 * pointer or mode change through a hunk action. Quoted (non-ASCII) Git paths are
 * refused explicitly rather than being guessed at.
 */
export function validateSingleFilePatch(patch: string, path: string): string | null {
  if (patch.length === 0) return 'The hunk patch is empty.'
  if (patch.length > MAX_PATCH_BYTES) return 'That hunk patch is too large to apply.'
  if (patch.includes('\u0000')) return 'That hunk patch is not valid text.'
  const lines = patch.split('\n')
  const structural = lines.map((line) => line.replace(/\r$/u, ''))
  if (structural.filter((line) => line.startsWith('diff --git ')).length !== 1) {
    return 'A hunk action must contain exactly one file patch.'
  }
  if (!structural.some((line) => line.startsWith('@@ '))) {
    return 'That patch contains no hunk.'
  }
  if (patch.includes('GIT binary patch') || patch.includes('Subproject commit')) {
    return 'Hunk staging is unavailable for binary files and submodules.'
  }
  if (
    structural.some((line) =>
      /^(rename from|rename to|copy from|copy to|old mode|new mode|similarity index|dissimilarity index)\b/u.test(
        line
      )
    )
  ) {
    return 'Hunk staging is unavailable for renames, copies and mode changes.'
  }
  const plus = structural.find((line) => line.startsWith('+++ '))
  const minus = structural.find((line) => line.startsWith('--- '))
  if (plus === undefined || minus === undefined) {
    return 'That patch has no file headers.'
  }
  const plusPath = plus.slice(4)
  const minusPath = minus.slice(4)
  if (plusPath.startsWith('"') || minusPath.startsWith('"')) {
    return 'Hunk staging does not support this path encoding yet.'
  }
  if (plusPath !== '/dev/null' && plusPath !== `b/${path}`) {
    return 'That patch targets a different path.'
  }
  if (minusPath !== '/dev/null' && minusPath !== `a/${path}`) {
    return 'That patch reads from a different path.'
  }
  return null
}
