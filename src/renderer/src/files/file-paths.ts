/** Worktree-relative paths use forward slashes; the root is the empty string. */

export function parentPathOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

export function basenameOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

export function isUnder(path: string, parent: string): boolean {
  return parent === '' || path === parent || path.startsWith(`${parent}/`)
}
