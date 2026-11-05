import { describe, expect, it } from 'vitest'
import { createGuestFileBackend } from './guest-file-backend'
import type { WslByteResult, WslCommandRunner } from '../wsl/exec'
import type { FileSearchOptions } from '../../shared/domain/workspace-files'

/**
 * The guest scripts are constants, so the interesting renderer-side behaviour
 * is parsing their output, applying the same filters as the local backend, and
 * preserving cancellation and conflict signals instead of reporting empty data.
 */

function bytes(stdout: string, code = 0): WslByteResult {
  return {
    code,
    signal: null,
    stdout: Buffer.from(stdout, 'utf8'),
    stderr: Buffer.alloc(0),
    timedOut: false
  }
}

function fakeRunner(
  onBytes: (argv: readonly string[]) => WslByteResult,
  onRun?: () => Awaited<ReturnType<WslCommandRunner['run']>>
): WslCommandRunner {
  return {
    runBytes: async (request: { argv: readonly string[] }) => onBytes(request.argv),
    run: async () => {
      if (onRun === undefined) throw new Error('unexpected run() call')
      return onRun()
    }
  } as unknown as WslCommandRunner
}

const OPTIONS: FileSearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: [],
  exclude: [],
  limit: 10
}

describe('guest files: search', () => {
  it('parses matches, applies include/exclude and reports scanned files', async () => {
    const calls: string[][] = []
    const runner = fakeRunner((argv) => {
      calls.push([...argv])
      return bytes(
        [
          'FILES 4',
          'src/a.ts:1:Needle here',
          'src/a.ts:3:needle again',
          'node_modules/x.js:1:needle',
          'docs/a.md:2:no match'
        ].join('\n')
      )
    })
    const backend = createGuestFileBackend(runner, 'Ubuntu', '/wt')

    const result = await backend.search('needle', {
      ...OPTIONS,
      exclude: ['node_modules/']
    })
    expect(result).toMatchObject({ truncated: false, scannedFiles: 4 })
    expect(
      result.matches.map((match) => `${match.path}:${String(match.line)}:${String(match.column)}`)
    ).toEqual(['src/a.ts:1:1', 'src/a.ts:3:1'])
    expect(calls[0]).toContain('0')

    const included = await backend.search('needle', {
      ...OPTIONS,
      include: ['src/**'],
      exclude: ['src/a.ts']
    })
    expect(included.matches).toEqual([])
  })

  it('turns a cancelled runner into a cancelled result', async () => {
    const controller = new AbortController()
    controller.abort()
    const backend = createGuestFileBackend(
      fakeRunner(() => bytes('', 143)),
      'Ubuntu',
      '/wt'
    )
    const result = await backend.search('needle', {
      ...OPTIONS,
      signal: controller.signal
    })
    expect(result).toEqual({ matches: [], truncated: false, scannedFiles: 0, cancelled: true })
  })

  it('refuses an invalid regular expression without running a scan', async () => {
    let called = false
    const backend = createGuestFileBackend(
      fakeRunner(() => {
        called = true
        return bytes('')
      }),
      'Ubuntu',
      '/wt'
    )
    await expect(
      backend.search('(', { ...OPTIONS, regex: true })
    ).rejects.toMatchObject({ reason: 'invalid-query' })
    expect(called).toBe(false)
  })
})

describe('guest files: writes', () => {
  it('keeps the conflicted version instead of reporting success', async () => {
    const backend = createGuestFileBackend(
      fakeRunner(() => bytes(''), () => ({
        status: 'exit_failure',
        code: 11,
        signal: null,
        stdout: 'CONFLICT sha256:abc\n',
        stderr: ''
      })),
      'Ubuntu',
      '/wt'
    )
    await expect(backend.write('a.ts', 'mine\n', 'sha256:stale')).rejects.toMatchObject({
      reason: 'changed-on-disk',
      currentEtag: 'sha256:abc'
    })
  })

  it('returns the confirmed size and next version', async () => {
    const runner = {
      runBytes: async () => bytes(''),
      run: async () => ({
        status: 'ok' as const,
        stdout: 'SIZE 5\nETAG sha256:next\n',
        stderr: ''
      })
    } as unknown as WslCommandRunner
    const backend = createGuestFileBackend(runner, 'Ubuntu', '/wt')
    expect(await backend.write('a.ts', 'mine\n', null)).toEqual({
      size: 5,
      etag: 'sha256:next'
    })
  })
})
