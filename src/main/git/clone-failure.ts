/**
 * Clone-specific failure classification.
 *
 * A clone started from the Add-project dialog is the one Git operation where a
 * user is present and can answer an authentication question. `GIT_AUTH_FAILED`
 * stays the terminal code for fetch/push/pull, where a background prompt would
 * be wrong; this module turns the same stderr into `GIT_AUTH_REQUIRED` and
 * records which entry point the dialog should open.
 */

import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import { parseRemoteUrl } from '../../shared/domain/remote-url'
import type { RemoteFailureInput } from './remote-failure'
import { classifyRemoteFailure } from './remote-failure'

export type CloneAuthHint = 'https' | 'ssh'

/** Diagnostics only the SSH transport can produce. */
const SSH_AUTH_PATTERN =
  /permission denied \(publickey|host key verification failed|no such identity|sign_and_send_pubkey|could not open a connection to your authentication agent|too many authentication failures|connection closed by authenticating user/iu

function failureText(input: RemoteFailureInput): string {
  const parts: string[] = []
  if (input.stderr !== undefined) parts.push(input.stderr)
  if (input.error !== undefined) {
    parts.push(input.error instanceof Error ? input.error.message : String(input.error))
  }
  return parts.join('\n')
}

/**
 * Classify a failed clone.
 *
 * Proxy, certificate, network and non-auth failures keep the codes the shared
 * classifier produced. Only a network URL whose Git output names an auth
 * problem becomes `GIT_AUTH_REQUIRED`; a local path can never open the
 * credential panel.
 */
export function classifyCloneFailure(input: RemoteFailureInput): AppError {
  const classified = classifyRemoteFailure(input)
  if (classified.code !== 'GIT_AUTH_FAILED') return classified

  const parsed = input.remoteUrl === null || input.remoteUrl === undefined
    ? null
    : parseRemoteUrl(input.remoteUrl)
  if (parsed === null || parsed.kind !== 'url' || parsed.isLocalPath) return classified

  const text = failureText(input)
  const sshTransport =
    parsed.scheme === 'ssh' || parsed.scheme === 'git+ssh' || SSH_AUTH_PATTERN.test(text)
  const authHint: CloneAuthHint = sshTransport ? 'ssh' : 'https'
  const host = parsed.host ?? 'the remote'

  const message =
    input.target.kind === 'wsl'
      ? `Git inside the ${input.target.distro} distro could not authenticate to ${host}. Enter your credentials or use an SSH key, then try again.`
      : `Git could not authenticate to ${host}. Enter your credentials or use an SSH key, then try again.`

  return makeAppError('GIT_AUTH_REQUIRED', message, {
    ...(classified.detail === undefined ? {} : { detail: classified.detail }),
    messageKey:
      input.target.kind === 'wsl' ? 'remote.auth.required.wsl' : 'remote.auth.required.local',
    messageParams:
      input.target.kind === 'wsl' ? { distro: input.target.distro, host } : { host },
    context: { operation: 'clone', authHint, host }
  })
}
