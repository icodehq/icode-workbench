/**
 * Generated directories a fresh repository should never commit.
 *
 * Lives in `shared` because the watcher process must prune the same names the
 * first-commit path excludes; importing the whole first-commit service into a
 * detached watcher would pull Git, staging, and platform code it never uses.
 */
export const GENERATED_IGNORE_PATTERNS = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.tox/',
  '.nox/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  '.parcel-cache/',
  '.gradle/'
] as const
