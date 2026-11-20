/**
 * One constant guest script for Add-project repository resolution.
 *
 * The per-call path (realpath, a directory check, the common Git dir, the
 * primary worktree, and the branch) used to be six separate `wsl.exe` spawns.
 * Each spawn costs about 80 ms before Git even starts, and the Add-project
 * request runs the whole sequence twice. This script answers all of it in one
 * guest process.
 *
 * Rules inherited from the session scripts:
 *   - `$1` is the resolved Git program and `$2` is the input path; nothing
 *     untrusted is interpolated into the script text.
 *   - The script always exits 0 and fences its payload with a sentinel, so a
 *     transport failure can never be mistaken for "not a Git repository".
 */

import {
  betweenMarkers,
  betweenSentinels,
  valueOf
} from './guest-script-payload'

export const RESOLVE_REPOSITORY_SENTINEL = '__ICODE_RESOLVE_REPOSITORY__'

/**
 * `$1` git program, `$2` input path.
 *
 * `realpath -e` matches the local resolver: the final component must exist, so
 * a missing folder is `missing`, not `not_directory`. A relative common dir is
 * resolved against the canonical input in the guest, never against the
 * controller's working directory.
 */
export const GUEST_RESOLVE_REPOSITORY_SCRIPT = [
  `__S=${RESOLVE_REPOSITORY_SENTINEL}`,
  'printf \'%s\\n\' "$__S"',
  '__phase=resolved',
  '__canonical=$(realpath -e -- "$2" 2>/dev/null) || __phase=missing',
  '[ -n "$__canonical" ] || __phase=missing',
  'if [ "$__phase" = resolved ] && [ ! -d "$__canonical" ]; then __phase=not_directory; fi',
  'if [ "$__phase" = resolved ] && ! command -v "$1" >/dev/null 2>&1; then __phase=git_missing; fi',
  '__common=',
  '__common_real=',
  '__primary=',
  '__primary_real=',
  '__branch=',
  '__common_error=',
  'if [ "$__phase" = resolved ]; then',
  '  __common=$("$1" -C "$__canonical" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)',
  '  __common_status=$?',
  '  if [ "$__common_status" -ne 0 ] || [ -z "$__common" ]; then',
  '    __common=$("$1" -C "$__canonical" rev-parse --git-common-dir 2>/dev/null)',
  '    __common_status=$?',
  '    if [ "$__common_status" -ne 0 ] || [ -z "$__common" ]; then',
  '      __common_error=$("$1" -C "$__canonical" rev-parse --git-common-dir 2>&1 >/dev/null)',
  '    fi',
  '  fi',
  '  case "$__common" in /*) ;; "") ;; *) __common="$__canonical/$__common" ;; esac',
  '  if [ "$__common_status" -ne 0 ] || [ -z "$__common" ]; then __phase=not_repository; fi',
  'fi',
  'if [ "$__phase" = resolved ]; then',
  '  __primary=$("$1" -C "$__canonical" worktree list --porcelain 2>/dev/null | sed -n \'s/^worktree //p\' | head -n 1)',
  '  if [ -z "$__primary" ]; then',
  '    __primary=$("$1" -C "$__canonical" rev-parse --show-toplevel 2>/dev/null)',
  '    __toplevel_status=$?',
  '    if [ "$__toplevel_status" -ne 0 ] || [ -z "$__primary" ]; then __phase=not_repository; fi',
  '  fi',
  'fi',
  'if [ "$__phase" = resolved ]; then',
  '  __common_real=$(realpath -e -- "$__common" 2>/dev/null)',
  '  [ -n "$__common_real" ] || __common_real=$__common',
  '  __primary_real=$(realpath -e -- "$__primary" 2>/dev/null)',
  '  [ -n "$__primary_real" ] || __primary_real=$__primary',
  '  __branch=$("$1" -C "$__primary_real" rev-parse --abbrev-ref HEAD 2>/dev/null)',
  '  __branch_status=$?',
  '  if [ "$__branch_status" -ne 0 ] || [ "$__branch" = HEAD ]; then __branch=; fi',
  'fi',
  'printf \'phase=%s\\n\' "$__phase"',
  'printf \'canonical=%s\\n\' "$__canonical"',
  'printf \'common=%s\\n\' "$__common_real"',
  'printf \'primary=%s\\n\' "$__primary_real"',
  'printf \'branch=%s\\n\' "$__branch"',
  'printf \'common_error_begin\\n%s\\ncommon_error_end\\n\' "$__common_error"',
  'printf \'%s\\n\' "$__S"',
  'exit 0'
].join('\n')

export type ResolveRepositoryPayload =
  | { phase: 'missing' | 'not_directory' | 'git_missing' }
  | { phase: 'not_repository'; detail: string }
  | {
      phase: 'resolved'
      canonicalInput: string
      root: string
      commonDir: string
      branch: string | null
    }

function absolute(value: string | undefined): string | null {
  return value !== undefined && value.startsWith('/') ? value : null
}

export function parseResolveRepository(
  stdout: string
): ResolveRepositoryPayload | null {
  const body = betweenSentinels(stdout, RESOLVE_REPOSITORY_SENTINEL)
  if (body === null) return null
  const phase = valueOf(body, 'phase')
  if (phase === 'missing' || phase === 'not_directory' || phase === 'git_missing') {
    return { phase }
  }
  if (phase === 'not_repository') {
    return {
      phase,
      detail: betweenMarkers(body, 'common_error_begin', 'common_error_end') ?? ''
    }
  }
  if (phase !== 'resolved') return null
  const canonicalInput = absolute(valueOf(body, 'canonical'))
  const root = absolute(valueOf(body, 'primary'))
  const commonDir = absolute(valueOf(body, 'common'))
  if (canonicalInput === null || root === null || commonDir === null) return null
  const branch = valueOf(body, 'branch')
  return {
    phase: 'resolved',
    canonicalInput,
    root,
    commonDir,
    branch: branch !== undefined && branch.length > 0 ? branch : null
  }
}
