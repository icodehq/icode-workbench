import { describe, expect, it } from 'vitest'
import { authFailureDetail, classifyRemoteFailure } from './remote-failure'
import type { ExecutionTarget } from '../../shared/domain/repository'

const local: ExecutionTarget = { kind: 'local' }
const wsl: ExecutionTarget = { kind: 'wsl', distro: 'Ubuntu', distroId: 'distro-1' }

describe('classifyRemoteFailure', () => {
  it('uses a local remedy for a local target', () => {
    const error = classifyRemoteFailure({
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      operation: 'clone',
      target: local,
      remoteUrl: 'https://github.com/o/r.git',
      fallback: 'The clone failed.'
    })
    expect(error.code).toBe('GIT_AUTH_FAILED')
    expect(error.messageKey).toBe('remote.auth.local')
    expect(error.messageParams).toEqual({ host: 'github.com' })
    expect(error.message).toContain('this machine')
    expect(error.context).toEqual({ operation: 'clone' })
  })

  it('names the distro for a WSL target', () => {
    const error = classifyRemoteFailure({
      error: new Error('Permission denied (publickey).'),
      operation: 'fetch',
      target: wsl,
      remoteUrl: 'git@gitlab.com:group/repo.git',
      fallback: 'The fetch failed.'
    })
    expect(error.code).toBe('GIT_AUTH_FAILED')
    expect(error.messageKey).toBe('remote.auth.wsl')
    expect(error.messageParams).toEqual({ distro: 'Ubuntu', host: 'gitlab.com' })
    expect(error.message).toContain('Ubuntu')
  })

  it('recognizes SSH host-key and agent failures', () => {
    for (const stderr of [
      'Host key verification failed.',
      'Could not open a connection to your authentication agent.',
      'sign_and_send_pubkey: signing failed for RSA key',
      'git@github.com: Permission denied (publickey).'
    ]) {
      expect(
        classifyRemoteFailure({ stderr, operation: 'push', target: local, fallback: 'failed' }).code
      ).toBe('GIT_AUTH_FAILED')
    }
  })

  it('classifies a non-auth failure as retryable remote failure', () => {
    const error = classifyRemoteFailure({
      stderr: 'fatal: unable to access: Could not resolve host: example.com',
      operation: 'clone',
      target: local,
      fallback: 'The repository could not be cloned.'
    })
    expect(error.code).toBe('GIT_REMOTE_FAILED')
    expect(error.retryable).toBe(true)
    expect(error.messageKey).toBe('errors.GIT_REMOTE_FAILED')
    expect(error.message).toBe('The repository could not be cloned.')
  })

  it('keeps a caller override for non-auth errors', () => {
    const error = classifyRemoteFailure({
      error: new Error('some failure'),
      operation: 'push',
      target: local,
      fallback: 'The target branch could not be pushed.',
      nonAuthCode: 'INTERNAL'
    })
    expect(error.code).toBe('INTERNAL')
  })

  it('redacts credentials from details', () => {
    const error = classifyRemoteFailure({
      stderr:
        'fatal: unable to access https://alice:ghp_token@github.com/o/r.git: 403 Forbidden',
      operation: 'fetch',
      target: local,
      fallback: 'The fetch failed.'
    })
    expect(error.detail).not.toContain('ghp_token')
    expect(error.detail).toContain('https://***@github.com')
  })

  it('caps a runaway detail at 2000 characters', () => {
    const error = classifyRemoteFailure({
      stderr: 'x'.repeat(10_000),
      operation: 'fetch',
      target: local,
      fallback: 'The fetch failed.'
    })
    expect(error.detail).toHaveLength(2_000)
  })

  it('uses a neutral word when the host cannot be determined', () => {
    const error = classifyRemoteFailure({
      stderr: 'fatal: Authentication failed.',
      operation: 'pull',
      target: local,
      fallback: 'The pull failed.'
    })
    expect(error.messageParams).toEqual({ host: 'the remote' })
  })

  it('builds a legacy detail string only for authentication failures', () => {
    const auth = authFailureDetail({
      stderr: 'git@github.com: Permission denied (publickey).',
      operation: 'push',
      target: local
    })
    expect(auth).toContain('this machine')
    expect(auth).toContain('Permission denied (publickey).')
    expect(
      authFailureDetail({
        stderr: 'fatal: unable to access: Could not resolve host',
        operation: 'push',
        target: local
      })
    ).toBeNull()
  })
})
