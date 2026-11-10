import { APP_BRANCH_PREFIX } from './app-identity'

/**
 * A conservative, synchronous branch-name check for UI feedback and for the
 * service boundary before Git is invoked. Main-process code still runs
 * `git check-ref-format --branch` as the authoritative check.
 */
export function isValidBranchName(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false
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

/** The default chain branch name for the first task in a dependency chain. */
export function chainBranchNameForTask(taskId: string): string {
  return `${APP_BRANCH_PREFIX}chain/${taskId}`
}
