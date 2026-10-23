/**
 * Local IPC endpoints.
 *
 * ADE talks to its detached Terminal Host and to the activity-hook ingress over
 * a local socket. POSIX uses a Unix-domain socket in the filesystem; Windows has
 * no such thing, and `server.listen(path)` there requires a named pipe. Keeping
 * the predicate in one place means the server, the CLI client and the hook
 * script cannot disagree about what a given endpoint string is.
 */

/** Namespace every ADE pipe lives in: `\\.\pipe\<name>`. */
export const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\'

/**
 * True when `endpoint` is a Windows pipe name rather than a filesystem path.
 *
 * Both the `\\.\pipe\` and the `\\?\pipe\` spellings are accepted, because a
 * caller may pass either; everything else — including a POSIX path that merely
 * contains a colon — is a path.
 */
export function isNamedPipe(endpoint: string): boolean {
  const normalised = endpoint.replace(/\//g, '\\')
  return (
    normalised.startsWith('\\\\.\\pipe\\') || normalised.startsWith('\\\\?\\pipe\\')
  )
}

/**
 * Deterministic pipe name for one profile namespace.
 *
 * The scope already isolates profiles on POSIX, so reusing it here keeps a
 * single notion of "which profile owns this endpoint". Pipe names carry no
 * directory component, so nothing has to be created on disk.
 */
export function namedPipe(namespace: string, scope: string): string {
  return `${WINDOWS_PIPE_PREFIX}${namespace}-${scope}`
}
