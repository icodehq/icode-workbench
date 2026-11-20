import { describe, expect, it } from 'vitest'
import {
  RESOLVE_REPOSITORY_SENTINEL,
  parseResolveRepository
} from './guest-repository-scripts'

function payload(lines: string[]): string {
  return ['login banner', RESOLVE_REPOSITORY_SENTINEL, ...lines, RESOLVE_REPOSITORY_SENTINEL, ''].join(
    '\n'
  )
}

describe('guest repository resolution payload', () => {
  it('reads a resolved repository', () => {
    expect(
      parseResolveRepository(
        payload([
          'phase=resolved',
          'canonical=/home/you/app',
          'common=/home/you/app/.git',
          'primary=/home/you/app',
          'branch=main',
          'common_error_begin',
          'common_error_end'
        ])
      )
    ).toEqual({
      phase: 'resolved',
      canonicalInput: '/home/you/app',
      root: '/home/you/app',
      commonDir: '/home/you/app/.git',
      branch: 'main'
    })
  })

  it('keeps a linked worktree distinguishable from its primary checkout', () => {
    const parsed = parseResolveRepository(
      payload([
        'phase=resolved',
        'canonical=/work/feature-checkout',
        'common=/home/you/app/.git',
        'primary=/home/you/app',
        'branch=main',
        'common_error_begin',
        'common_error_end'
      ])
    )
    expect(parsed).toMatchObject({
      phase: 'resolved',
      canonicalInput: '/work/feature-checkout',
      root: '/home/you/app'
    })
  })

  it('reads an unborn branch as null', () => {
    expect(
      parseResolveRepository(
        payload([
          'phase=resolved',
          'canonical=/home/you/app',
          'common=/home/you/app/.git',
          'primary=/home/you/app',
          'branch=',
          'common_error_begin',
          'common_error_end'
        ])
      )
    ).toMatchObject({ phase: 'resolved', branch: null })
  })

  it('carries the phase verdicts unchanged', () => {
    for (const phase of ['missing', 'not_directory', 'git_missing'] as const) {
      expect(parseResolveRepository(payload([`phase=${phase}`]))).toEqual({ phase })
    }
  })

  it('keeps Git stderr as the not-a-repository detail', () => {
    expect(
      parseResolveRepository(
        payload([
          'phase=not_repository',
          'common_error_begin',
          'fatal: not a git repository (or any of the parent directories): .git',
          'common_error_end'
        ])
      )
    ).toEqual({
      phase: 'not_repository',
      detail: 'fatal: not a git repository (or any of the parent directories): .git'
    })
  })

  it('refuses a payload outside the sentinel fence', () => {
    expect(parseResolveRepository('phase=resolved\ncanonical=/home/you/app')).toBeNull()
  })

  it('refuses a resolved payload without absolute paths', () => {
    expect(
      parseResolveRepository(
        payload([
          'phase=resolved',
          'canonical=.',
          'common=.git',
          'primary=..',
          'branch=main'
        ])
      )
    ).toBeNull()
  })

  it('refuses an unknown phase', () => {
    expect(parseResolveRepository(payload(['phase=confused']))).toBeNull()
  })
})
