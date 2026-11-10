/**
 * Constant guest scripts for the session-create hot path.
 *
 * Each script replaces a sequence of separate `wsl.exe` calls with one spawn.
 * Every path/name travels as a positional parameter; the script text never
 * interpolates untrusted data. The scripts always exit 0 and carry Git verdicts
 * in a sentinel-delimited payload, so a transport failure can never be mistaken
 * for "not a Git repository" or "no operation in progress".
 */

export const INSPECT_FOR_CREATE_SENTINEL = '__ICODE_INSPECT_FOR_CREATE__'
export const CREATE_WORKTREE_SENTINEL = '__ICODE_CREATE_WORKTREE__'

/**
 * `$1` git program, `$2` workspace path, `$3` primary root.
 *
 * Relative `--git-common-dir`/`--git-dir` values are resolved here, relative to
 * the root where `git -C` made its cwd. Resolving them host-side would silently
 * depend on the controller's filesystem and its spelling of the path.
 */
export const GUEST_INSPECT_FOR_CREATE_SCRIPT = [
  `__S=${INSPECT_FOR_CREATE_SENTINEL}`,
  'printf \'%s\\n\' "$__S"',
  'if [ -d "$2" ]; then printf \'workspace=present\\n\'; else printf \'workspace=missing\\n\'; fi',
  'if [ -d "$3" ]; then printf \'root=present\\n\'; else printf \'root=missing\\n\'; fi',
  'if command -v "$1" >/dev/null 2>&1; then printf \'git=present\\n\'; else printf \'git=missing\\n\'; fi',
  '__verify_status=0',
  '__verify=$("$1" -C "$3" rev-parse --verify HEAD 2>/dev/null) || __verify_status=$?',
  'printf \'verify_status=%s\\n\' "$__verify_status"',
  'printf \'head=%s\\n\' "$__verify"',
  '__ref=$("$1" -C "$3" rev-parse --abbrev-ref HEAD 2>/dev/null)',
  'printf \'ref=%s\\n\' "$__ref"',
  '__common=$("$1" -C "$3" rev-parse --git-common-dir 2>/dev/null)',
  '__gitdir=$("$1" -C "$3" rev-parse --git-dir 2>/dev/null)',
  // The same marker order and precedence as IN_PROGRESS_MARKERS: the worktree's
  // own git dir first, then the shared common dir when they differ.
  'case "$__common" in /*) ;; *) __common="$3/$__common" ;; esac',
  'case "$__gitdir" in /*) ;; *) __gitdir="$3/$__gitdir" ;; esac',
  '__op=',
  'for __marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply BISECT_LOG; do',
  '  if [ -e "$__gitdir/$__marker" ] || { [ "$__gitdir" != "$__common" ] && [ -e "$__common/$__marker" ]; }; then',
  '    __op=$__marker; break',
  '  fi',
  'done',
  'printf \'operation=%s\\n\' "$__op"',
  'printf \'%s\\n\' "$__S"',
  'exit 0'
].join('\n')

export type InspectForCreatePayload = {
  workspacePresent: boolean
  rootPresent: boolean
  gitPresent: boolean
  verifyStatus: number
  head: string | null
  ref: string | null
  operation: string | null
}

function emptyToNull(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null
}

function betweenSentinels(
  stdout: string,
  sentinel: string
): string[] | null {
  const lines = stdout.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.trim() === sentinel)
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && line.trim() === sentinel)
  if (end === -1) return null
  return lines.slice(start + 1, end)
}

function valueOf(lines: readonly string[], key: string): string | undefined {
  const prefix = `${key}=`
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length)
  }
  return undefined
}

function betweenMarkers(
  lines: readonly string[],
  startMarker: string,
  endMarker: string
): string | null {
  const start = lines.findIndex((line) => line.trim() === startMarker)
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && line.trim() === endMarker)
  if (end === -1) return null
  return lines.slice(start + 1, end).join('\n').trim()
}

export function parseInspectForCreate(
  stdout: string
): InspectForCreatePayload | null {
  const body = betweenSentinels(stdout, INSPECT_FOR_CREATE_SENTINEL)
  if (body === null) return null
  const workspace = valueOf(body, 'workspace')
  const root = valueOf(body, 'root')
  const git = valueOf(body, 'git')
  const verifyStatusText = valueOf(body, 'verify_status')
  if (
    (workspace !== 'present' && workspace !== 'missing') ||
    (root !== 'present' && root !== 'missing') ||
    (git !== 'present' && git !== 'missing') ||
    verifyStatusText === undefined
  ) {
    return null
  }
  const verifyStatus = Number(verifyStatusText)
  if (!Number.isInteger(verifyStatus) || verifyStatus < 0) return null
  return {
    workspacePresent: workspace === 'present',
    rootPresent: root === 'present',
    gitPresent: git === 'present',
    verifyStatus,
    head: emptyToNull(valueOf(body, 'head')),
    ref: emptyToNull(valueOf(body, 'ref')),
    operation: emptyToNull(valueOf(body, 'operation'))
  }
}

/**
 * `$1` git program, `$2` primary root, `$3` worktree path, `$4` branch,
 * `$5` base OID.
 *
 * The raw `add` output and the porcelain list are delimited separately, so Git
 * text can never be mistaken for a key. The script is a mutation: the caller
 * runs it exactly once and never retries a transport failure.
 */
export const GUEST_CREATE_WORKTREE_SCRIPT = [
  `__S=${CREATE_WORKTREE_SENTINEL}`,
  'printf \'%s\\n\' "$__S"',
  'if [ -d "$3" ]; then printf \'exists=1\\n\'; printf \'%s\\n\' "$__S"; exit 0; fi',
  'printf \'exists=0\\n\'',
  '__mkdir_status=0',
  '( umask 077; mkdir -p -- "$(dirname -- "$3")" ) 2>/dev/null || __mkdir_status=$?',
  'printf \'mkdir=%s\\n\' "$__mkdir_status"',
  'if [ "$__mkdir_status" -ne 0 ]; then printf \'%s\\n\' "$__S"; exit 0; fi',
  '__add_out=$("$1" -C "$2" worktree add -b "$4" "$3" "$5" 2>&1)',
  '__add_status=$?',
  'printf \'add=%s\\n\' "$__add_status"',
  'printf \'add_begin\\n%s\\nadd_end\\n\' "$__add_out"',
  'if [ "$__add_status" -ne 0 ]; then printf \'%s\\n\' "$__S"; exit 0; fi',
  '__top=$("$1" -C "$3" rev-parse --show-toplevel 2>/dev/null)',
  'printf \'toplevel=%s\\n\' "$__top"',
  '__head=$("$1" -C "$3" rev-parse HEAD 2>/dev/null)',
  'printf \'head=%s\\n\' "$__head"',
  'printf \'worktrees_begin\\n\'',
  '"$1" -C "$2" worktree list --porcelain 2>/dev/null',
  'printf \'\\nworktrees_end\\n\'',
  'printf \'%s\\n\' "$__S"',
  'exit 0'
].join('\n')

export type CreateWorktreePayload =
  | { phase: 'exists' }
  | { phase: 'mkdir_failed'; status: number }
  | { phase: 'add_failed'; status: number; output: string }
  | {
      phase: 'created'
      topLevel: string
      head: string | null
      /** Raw `git worktree list --porcelain` output. */
      worktrees: string
    }

export function parseCreateWorktree(stdout: string): CreateWorktreePayload | null {
  const body = betweenSentinels(stdout, CREATE_WORKTREE_SENTINEL)
  if (body === null) return null
  const exists = valueOf(body, 'exists')
  if (exists === '1') return { phase: 'exists' }
  if (exists !== '0') return null

  const mkdirText = valueOf(body, 'mkdir')
  if (mkdirText === undefined) return null
  const mkdirStatus = Number(mkdirText)
  if (!Number.isInteger(mkdirStatus) || mkdirStatus < 0) return null
  if (mkdirStatus !== 0) return { phase: 'mkdir_failed', status: mkdirStatus }

  const addText = valueOf(body, 'add')
  if (addText === undefined) return null
  const addStatus = Number(addText)
  if (!Number.isInteger(addStatus) || addStatus < 0) return null
  const addOutput = betweenMarkers(body, 'add_begin', 'add_end') ?? ''
  if (addStatus !== 0) {
    return { phase: 'add_failed', status: addStatus, output: addOutput }
  }

  return {
    phase: 'created',
    topLevel: valueOf(body, 'toplevel') ?? '',
    head: emptyToNull(valueOf(body, 'head')),
    worktrees: betweenMarkers(body, 'worktrees_begin', 'worktrees_end') ?? ''
  }
}
