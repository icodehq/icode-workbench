/**
 * Turns a Git transport failure into an actionable application error.
 *
 * Authentication is the one remote failure the user can usually fix, so it gets
 * its own code and wording — and the wording names the environment that must be
 * configured. A Windows credential helper does not exist inside a WSL distro,
 * and telling a WSL user to configure "this machine" sends them to the wrong
 * place.
 *
 * Every detail is credential-redacted here rather than at each call site: Git
 * echoes remote URLs in its errors, and a URL may embed a token.
 */

import type { AppError, AppErrorCode } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { MessageKey } from '../../shared/i18n/messages'
import { parseRemoteUrl, redactRemoteUrlCredentials } from '../../shared/domain/remote-url'

export type RemoteOperation = 'fetch' | 'clone' | 'push' | 'pull' | 'publish' | 'remote'

const AUTH_FAILURE =
  /authentication failed|could not read (?:username|password)|terminal prompts disabled|permission denied|host key verification failed|no such identity|could not open a connection to your authentication agent|sign_and_send_pubkey|http basic: access denied|invalid username or password|repository not found|access denied|authentication required/iu

const URL_HOST = /(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/\s]+@)?([A-Za-z0-9.-]+)/iu
const MAX_DETAIL = 2_000

export type RemoteFailureInput = {
  /** The thrown value, whose message may carry Git's stderr. */
  error?: unknown
  /** Git's stderr, when the caller ran the command directly. */
  stderr?: string
  operation: RemoteOperation
  target: ExecutionTarget
  remoteUrl?: string | null
  /** Message shown for a non-auth failure. */
  fallback: string
  /** Defaults to GIT_REMOTE_FAILED; merge push keeps INTERNAL for compatibility. */
  nonAuthCode?: AppErrorCode
}

function textOf(input: RemoteFailureInput): string {
  const parts: string[] = []
  if (input.stderr !== undefined && input.stderr.trim().length > 0) parts.push(input.stderr)
  if (input.error !== undefined) {
    const message = input.error instanceof Error ? input.error.message : String(input.error)
    if (message.trim().length > 0) parts.push(message)
  }
  return parts.join('\n')
}

function cap(value: string): string | undefined {
  const redacted = redactRemoteUrlCredentials(value).trim()
  return redacted.length === 0 ? undefined : redacted.slice(0, MAX_DETAIL)
}

function hostOf(input: RemoteFailureInput, text: string): string | null {
  const fromUrl = input.remoteUrl === null || input.remoteUrl === undefined
    ? null
    : (parseRemoteUrl(input.remoteUrl)?.host ?? null)
  if (fromUrl !== null) return fromUrl
  return URL_HOST.exec(text)?.[1]?.toLowerCase() ?? null
}

/**
 * The auth message names the environment the user must change: this machine, or
 * the selected distro.
 */
export function authMessage(
  target: ExecutionTarget,
  host: string | null
): { message: string; messageKey: MessageKey; messageParams: Record<string, string> } {
  const displayHost = host ?? 'the remote'
  if (target.kind === 'wsl') {
    return {
      message: `Git inside the ${target.distro} distro could not authenticate to ${displayHost}. Configure the credential helper or SSH key inside that distro, then try again.`,
      messageKey: 'remote.auth.wsl',
      messageParams: { distro: target.distro, host: displayHost }
    }
  }
  return {
    message: `Git could not authenticate to ${displayHost}. Configure the system credential helper or an SSH key on this machine, then try again.`,
    messageKey: 'remote.auth.local',
    messageParams: { host: displayHost }
  }
}

export function classifyRemoteFailure(input: RemoteFailureInput): AppError {
  const text = textOf(input)
  const detail = cap(text)
  if (AUTH_FAILURE.test(text)) {
    const auth = authMessage(input.target, hostOf(input, text))
    return makeAppError('GIT_AUTH_FAILED', auth.message, {
      ...(detail === undefined ? {} : { detail }),
      messageKey: auth.messageKey,
      messageParams: auth.messageParams,
      context: { operation: input.operation }
    })
  }
  return makeAppError(input.nonAuthCode ?? 'GIT_REMOTE_FAILED', input.fallback, {
    ...(detail === undefined ? {} : { detail }),
    messageKey: 'errors.GIT_REMOTE_FAILED',
    context: { operation: input.operation }
  })
}

/**
 * A ready-to-display message for a legacy `GitOutcome` detail field.
 *
 * Only authentication is enriched: every other failure keeps Git's own text,
 * exactly as before. `GitOutcome` carries no message key, so this returns the
 * English message the rest of that surface already uses.
 */
export function authFailureDetail(input: {
  error?: unknown
  stderr?: string
  operation: RemoteOperation
  target: ExecutionTarget
}): string | null {
  const classified = classifyRemoteFailure({
    ...input,
    fallback: 'The Git operation failed.'
  })
  if (classified.code !== 'GIT_AUTH_FAILED') return null
  return classified.detail === undefined
    ? classified.message
    : `${classified.message}\n${classified.detail}`
}
