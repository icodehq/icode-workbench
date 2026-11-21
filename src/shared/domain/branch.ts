import { APP_BRANCH_PREFIX } from './app-identity'

export const BRANCH_REF_KINDS = ['local', 'remote'] as const
export type BranchRefKind = (typeof BRANCH_REF_KINDS)[number]

/** A remote-tracking ref split against the configured remote names. */
export type RemoteTrackingRef = {
  remote: string
  branch: string
  fullRef: string
}

export type StartRefCandidate = {
  ref: string
  remoteTracking: RemoteTrackingRef | null
}

const MAX_BRANCH_NAME_LENGTH = 255
const MAX_START_REF_LENGTH = 1024

/**
 * A conservative, synchronous ref-name check for UI feedback and for the
 * service boundary before Git is invoked. Main-process code still runs
 * `git check-ref-format --branch` as the authoritative check.
 */
function isValidRefSyntax(value: string): boolean {
  if (value.length === 0) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false
  if (value.endsWith('.') || value.endsWith('.lock')) return false
  if (value.includes('..') || value.includes('@{') || value.includes('//')) return false
  if (/[\s~^:?*[\\]/u.test(value)) return false
  // Git rejects a component that begins with a dot or ends with `.lock`.
  const components = value.split('/')
  if (components.some((part) => part.length === 0 || part.startsWith('.') || part.endsWith('.lock'))) {
    return false
  }
  return true
}

export function isValidBranchName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_BRANCH_NAME_LENGTH && isValidRefSyntax(value)
}

/**
 * A start-from value may be a local branch, a remote-tracking branch, or a
 * full `refs/heads/*` / `refs/remotes/*` ref. Tags and other ref namespaces are
 * deliberately out of scope for session bases.
 */
export function isValidStartRef(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_START_REF_LENGTH) return false
  if (!isValidRefSyntax(trimmed)) return false
  if (!trimmed.startsWith('refs/')) return true
  if (trimmed.startsWith('refs/heads/')) {
    return trimmed.length > 'refs/heads/'.length
  }
  if (trimmed.startsWith('refs/remotes/')) {
    return trimmed.length > 'refs/remotes/'.length
  }
  return false
}

function longestConfiguredRemote(
  branchAndRemote: string,
  remoteNames: readonly string[]
): string | null {
  let match: string | null = null
  for (const remote of remoteNames) {
    if (remote.length === 0 || !branchAndRemote.startsWith(`${remote}/`)) continue
    if (match === null || remote.length > match.length) match = remote
  }
  return match
}

/**
 * Split a remote-tracking ref against configured remote names. The longest
 * remote wins, so slash-containing remote names stay unambiguous.
 */
export function parseRemoteTrackingRef(
  fullRef: string,
  remoteNames: readonly string[]
): RemoteTrackingRef | null {
  if (!fullRef.startsWith('refs/remotes/') || !isValidRefSyntax(fullRef)) return null
  const rest = fullRef.slice('refs/remotes/'.length)
  const remote = longestConfiguredRemote(rest, remoteNames)
  if (remote === null) return null
  const branch = rest.slice(remote.length + 1)
  // `<remote>/HEAD` is a symbolic pointer, not a branch identity.
  if (branch.length === 0 || branch === 'HEAD') return null
  return { remote, branch, fullRef }
}

/**
 * True for the symbolic `<remote>/HEAD` slot. A real branch may still be named
 * `feature/HEAD`; only the direct component is excluded.
 */
export function isRemoteHeadRef(ref: string, remoteNames: readonly string[]): boolean {
  if (!ref.startsWith('refs/remotes/')) return false
  const rest = ref.slice('refs/remotes/'.length)
  const remote = longestConfiguredRemote(rest, remoteNames)
  if (remote !== null) return rest === `${remote}/HEAD`
  // A stale ref from a removed remote still looks like `<remote>/HEAD`.
  const parts = rest.split('/')
  return parts.length === 2 && parts[1] === 'HEAD'
}

/**
 * Ordered refs to probe for a start-from value.
 *
 * Bare names are local-first so an existing local branch (including one
 * literally named `origin/foo`) keeps its historical meaning; the UI sends
 * full remote refs when the user chooses a remote branch.
 */
export function startRefCandidates(
  ref: string,
  remoteNames: readonly string[]
): StartRefCandidate[] {
  const value = ref.trim()
  if (!isValidStartRef(value)) return []
  if (value.startsWith('refs/heads/')) {
    return [{ ref: value, remoteTracking: null }]
  }
  if (value.startsWith('refs/remotes/')) {
    if (isRemoteHeadRef(value, remoteNames)) return []
    return [{ ref: value, remoteTracking: parseRemoteTrackingRef(value, remoteNames) }]
  }
  if (value.startsWith('refs/')) return []

  const candidates: StartRefCandidate[] = [{ ref: `refs/heads/${value}`, remoteTracking: null }]
  const remoteRef = `refs/remotes/${value}`
  if (!isRemoteHeadRef(remoteRef, remoteNames)) {
    const remoteTracking = parseRemoteTrackingRef(remoteRef, remoteNames)
    if (remoteTracking !== null) candidates.push({ ref: remoteRef, remoteTracking })
  }
  return candidates
}

/** The default chain branch name for the first task in a dependency chain. */
export function chainBranchNameForTask(taskId: string): string {
  return `${APP_BRANCH_PREFIX}chain/${taskId}`
}
