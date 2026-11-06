/**
 * A small, bounded glob matcher for Files visibility and search filters.
 *
 * Supported: `*` within a segment, `**` across segments, `?`, trailing `/` for
 * folders and their descendants, and a leading `!` re-include. A pattern with
 * no slash matches a basename at any depth. The last matching pattern wins,
 * which is the behaviour users expect from `files.exclude` lists.
 */

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
}

function patternBody(pattern: string): string {
  const trimmed = pattern.trim()
  const negated = trimmed.startsWith('!')
  let body = negated ? trimmed.slice(1) : trimmed
  if (body.startsWith('./')) body = body.slice(2)
  const directoryOnly = body.endsWith('/')
  if (directoryOnly) body = body.replace(/\/+$/u, '')
  return `${negated ? '!' : ''}${body}${directoryOnly ? '/' : ''}`
}

function compile(
  body: string,
  directoryOnly = false
): { regex: RegExp } {
  let source = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? ''
    if (char === '*') {
      if (body[index + 1] === '*') {
        index += 1
        if (body[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += escapeRegex(char)
  }
  const hasSlash = body.includes('/')
  const prefix = hasSlash ? '^' : '(?:^|/)'
  return {
    regex: new RegExp(
      `${prefix}${source}${directoryOnly ? '(?:/.*)?' : ''}$`,
      'u'
    )
  }
}

type Compiled = {
  negated: boolean
  directoryOnly: boolean
  regex: RegExp
}

function compilePattern(raw: string): Compiled | null {
  const body = patternBody(raw)
  if (body === '!' || body === '') return null
  const negated = body.startsWith('!')
  const withoutNegation = negated ? body.slice(1) : body
  const directoryOnly = withoutNegation.endsWith('/')
  const cleaned = directoryOnly ? withoutNegation.replace(/\/+$/u, '') : withoutNegation
  if (cleaned === '') return null
  const { regex } = compile(cleaned, directoryOnly)
  return { negated, directoryOnly, regex }
}

/** True when one pattern matches this exact path (no ancestor walk). */
export function matchesGlob(path: string, pattern: string, isDirectory = false): boolean {
  const compiled = compilePattern(pattern)
  if (compiled === null) return false
  if (compiled.directoryOnly && !isDirectory) {
    // A folder pattern may still match a descendant; callers ask isExcluded.
    return compiled.regex.test(path)
  }
  return compiled.regex.test(path)
}

function prefixes(path: string): Array<{ path: string; isDirectory: boolean }> {
  const segments = path.split('/').filter((segment) => segment !== '')
  const result: Array<{ path: string; isDirectory: boolean }> = []
  let current = ''
  for (let index = 0; index < segments.length; index += 1) {
    current = current === '' ? (segments[index] ?? '') : `${current}/${segments[index] ?? ''}`
    result.push({ path: current, isDirectory: index < segments.length - 1 })
  }
  return result
}

/**
 * Applies `files.exclude` semantics, including excluded ancestors and
 * last-match-wins negation.
 */
export function isExcluded(
  path: string,
  isDirectory: boolean,
  patterns: readonly string[]
): boolean {
  if (patterns.length === 0 || path === '') return false
  const candidates = prefixes(path)
  if (candidates.length === 0) return false
  candidates[candidates.length - 1] = { path, isDirectory }
  let excluded = false
  for (const raw of patterns) {
    const compiled = compilePattern(raw)
    if (compiled === null) continue
    const hit = candidates.some((candidate) => {
      if (compiled.directoryOnly && !candidate.isDirectory) {
        // `dir/` still hides a file inside `dir`; the ancestor candidate
        // matches the directory itself.
        return false
      }
      return compiled.regex.test(candidate.path)
    })
    if (hit) excluded = !compiled.negated
  }
  return excluded
}

/**
 * Include/exclude rules for search. Include is a whitelist when non-empty;
 * exclude uses the same ancestor-aware semantics as the tree.
 */
export function isSearchPathIncluded(
  path: string,
  include: readonly string[],
  exclude: readonly string[]
): boolean {
  let included = include.length === 0
  for (const raw of include) {
    const compiled = compilePattern(raw)
    if (compiled === null) continue
    if (compiled.regex.test(path)) included = !compiled.negated
  }
  if (!included) return false
  return !isExcluded(path, false, exclude)
}
