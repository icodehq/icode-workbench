import { describe, expect, it } from 'vitest'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { classifyCloneFailure } from './clone-failure'

const local: ExecutionTarget = { kind: 'local' }
const wsl: ExecutionTarget = { kind: 'wsl', distro: 'Ubuntu', distroId: 'distro-1' }

function classify(
  stderr: string,
  remoteUrl = 'https://gitee.com/o/r.git',
  target: ExecutionTarget = local
) {
  return classifyCloneFailure({
    stderr,
    operation: 'clone',
    target,
    remoteUrl,
    fallback: 'The repository could not be cloned.'
  })
}

describe('classifyCloneFailure', () => {
  it('turns an HTTPS auth failure into an interactive requirement', () => {
    const error = classify('fatal: could not read Username: terminal prompts disabled')
    expect(error).toMatchObject({
      code: 'GIT_AUTH_REQUIRED',
      messageKey: 'remote.auth.required.local',
      retryable: false,
      context: { operation: 'clone', authHint: 'https', host: 'gitee.com' }
    })
    expect(error.messageParams).toEqual({ host: 'gitee.com' })
  })

  it('names the distro for a WSL auth requirement', () => {
    const error = classify('fatal: Authentication failed', 'https://gitee.com/o/r.git', wsl)
    expect(error).toMatchObject({
      code: 'GIT_AUTH_REQUIRED',
      messageKey: 'remote.auth.required.wsl'
    })
    expect(error.messageParams).toEqual({ distro: 'Ubuntu', host: 'gitee.com' })
  })

  it('routes SSH diagnostics to the SSH entry point', () => {
    const error = classify(
      'git@gitee.com: Permission denied (publickey).',
      'git@gitee.com:o/r.git'
    )
    expect(error).toMatchObject({
      code: 'GIT_AUTH_REQUIRED',
      context: { authHint: 'ssh' }
    })
  })

  it('does not turn a proxy or network failure into an auth step', () => {
    expect(
      classify('fatal: unable to access: Received HTTP code 407 from proxy after CONNECT').code
    ).toBe('GIT_PROXY_FAILED')
    expect(
      classify('fatal: unable to access: Could not resolve host: gitee.com').code
    ).toBe('GIT_REMOTE_FAILED')
  })

  it('never opens the auth step for a local path', () => {
    const error = classify(
      'fatal: could not read Username: terminal prompts disabled',
      '/srv/git/repo.git'
    )
    expect(error.code).toBe('GIT_AUTH_FAILED')
  })

  it('keeps credentials out of the detail', () => {
    const error = classify(
      "fatal: could not read Username for 'https://alice:secret-token@gitee.com/o/r.git'"
    )
    expect(error.code).toBe('GIT_AUTH_REQUIRED')
    expect(error.detail).not.toContain('secret-token')
  })
})
