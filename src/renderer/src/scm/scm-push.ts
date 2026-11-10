export type PushDefaults = {
  remote: string
  branch: string
  /** Empty when the defaults are usable; otherwise an i18n key or message. */
  reason: string
}

/**
 * Parses a configured upstream such as `origin/feature/x`.
 *
 * Remote names may themselves contain slashes, so configured remote names are
 * matched longest-first before falling back to the first slash.
 */
export function parseUpstream(
  upstream: string | null,
  remotes: readonly string[]
): { remote: string; branch: string } | null {
  if (upstream === null || upstream.length === 0) return null
  const sorted = [...remotes].sort((left, right) => right.length - left.length)
  for (const remote of sorted) {
    const prefix = `${remote}/`
    if (upstream.startsWith(prefix) && upstream.length > prefix.length) {
      return { remote, branch: upstream.slice(prefix.length) }
    }
  }
  const slash = upstream.indexOf('/')
  if (slash <= 0 || slash === upstream.length - 1) return null
  return { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) }
}

/**
 * Picks the remote and branch shown when the Push to… popover opens.
 *
 * `remotes === null` means the remote list is still loading; the popover shows
 * a loading note and the submit stays disabled.
 */
export function pushDefaults(input: {
  upstream: string | null
  localBranch: string | null
  headOid: string | null
  remotes: readonly string[] | null
}): PushDefaults {
  if (input.headOid === null) {
    return { remote: '', branch: '', reason: 'scm.push.unborn' }
  }
  if (input.localBranch === null) {
    return { remote: '', branch: '', reason: 'scm.push.detached' }
  }
  if (input.remotes === null) {
    return { remote: '', branch: input.localBranch, reason: 'scm.push.loadingRemotes' }
  }
  if (input.remotes.length === 0) {
    return { remote: '', branch: input.localBranch, reason: 'push.noRemotes' }
  }
  const upstream = parseUpstream(input.upstream, input.remotes)
  if (upstream !== null && input.remotes.includes(upstream.remote)) {
    return { remote: upstream.remote, branch: upstream.branch, reason: '' }
  }
  const remote = input.remotes.includes('origin') ? 'origin' : input.remotes[0]!
  return { remote, branch: input.localBranch, reason: '' }
}
