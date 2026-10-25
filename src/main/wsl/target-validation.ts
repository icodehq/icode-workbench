/**
 * Is this repository's WSL target still the thing it says it is?
 *
 * A stored `ExecutionTarget` is a claim made at registration time: a name, and a
 * registration id when one could be read. Before a Host launch consumes that
 * claim, three things have to hold — and each failure is a distinct answer,
 * because the remedies differ:
 *
 *   - the name no longer exists          → re-point the repository
 *   - the name exists, the id does not   → a *different* distro was imported
 *                                          under that name; the old one is gone
 *   - the registry cannot be read        → unknown, retry
 *
 * The id check is the reason W1 stores it. Matching on the name alone would bind
 * a repository to an unrelated distro that merely reused the name after an
 * unregister and reimport.
 */

import { makeAppError, type AppError } from '../../shared/domain/errors'
import type { ExecutionTarget, WslExecutionTarget } from '../../shared/domain/repository'
import { discoverWslDistros, type WslDistro, type WslDistroDiscoveryDeps } from './distros'

export type WslTargetProblem =
  /** The caller asked to validate something that is not a WSL target. */
  | { kind: 'not_wsl_target' }
  /** WSL itself is unavailable (not Windows, or the registry is unreadable). */
  | { kind: 'wsl_unavailable'; detail: string }
  /** No registration carries this name. */
  | { kind: 'distro_not_found'; distro: string; available: readonly string[] }
  /**
   * The name exists but belongs to a different registration than the one W1
   * recorded — the distro was replaced, not renamed.
   */
  | { kind: 'registration_replaced'; distro: string; expected: string; actual: string }
  /** The registration is WSL 1, which cannot run a Linux Host. */
  | { kind: 'unsupported_wsl1'; distro: string }

export type WslTargetValidation =
  | { ok: true; target: WslExecutionTarget; distro: WslDistro }
  | { ok: false; problem: WslTargetProblem }

/** Case-insensitive, trimmed: the registry and the user may differ in case only. */
function sameDistroName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

/**
 * Pure core: compares a target against an already-discovered list.
 *
 * Kept separate from discovery so the decision table is testable without a
 * Windows host or a registry.
 */
export function validateWslTargetAgainst(
  target: ExecutionTarget,
  discovery: Awaited<ReturnType<typeof discoverWslDistros>>
): WslTargetValidation {
  if (target.kind !== 'wsl') return { ok: false, problem: { kind: 'not_wsl_target' } }

  if (discovery.status !== 'ok') {
    return { ok: false, problem: { kind: 'wsl_unavailable', detail: discovery.detail } }
  }

  const match = discovery.distros.find((distro) => sameDistroName(distro.name, target.distro))
  if (!match) {
    return {
      ok: false,
      problem: {
        kind: 'distro_not_found',
        distro: target.distro,
        available: discovery.distros.map((distro) => distro.name)
      }
    }
  }

  // A renamed distro keeps its id, so this passes. A reimported distro under the
  // same name does not, and must not be silently adopted.
  if (target.distroId !== null && target.distroId !== match.registrationId) {
    return {
      ok: false,
      problem: {
        kind: 'registration_replaced',
        distro: target.distro,
        expected: target.distroId,
        actual: match.registrationId
      }
    }
  }

  if (match.version === 1) {
    return { ok: false, problem: { kind: 'unsupported_wsl1', distro: match.name } }
  }

  return {
    ok: true,
    // Report the registry's spelling, which is what `wsl.exe -d` expects.
    target: { kind: 'wsl', distro: match.name, distroId: match.registrationId },
    distro: match
  }
}

/** Discovers, then validates. Never throws for a bad target. */
export async function validateWslTarget(
  target: ExecutionTarget,
  deps: WslDistroDiscoveryDeps
): Promise<WslTargetValidation> {
  const discovery = await discoverWslDistros(deps)
  return validateWslTargetAgainst(target, discovery)
}

/** Maps a problem onto the app's error vocabulary. One code per remedy. */
export function wslTargetProblemToAppError(problem: WslTargetProblem): AppError {
  switch (problem.kind) {
    case 'not_wsl_target':
      return makeAppError('INVALID_ARGUMENT', 'That repository does not run in WSL.')
    case 'wsl_unavailable':
      return makeAppError('WSL_UNAVAILABLE', 'WSL is not available on this machine.', {
        detail: problem.detail
      })
    case 'distro_not_found':
      return makeAppError('WSL_DISTRO_NOT_FOUND', `The WSL distro "${problem.distro}" is gone.`, {
        detail:
          problem.available.length > 0
            ? `Installed distros: ${problem.available.join(', ')}`
            : 'No WSL distros are registered.',
        context: { distro: problem.distro }
      })
    case 'registration_replaced':
      return makeAppError(
        'WSL_DISTRO_NOT_FOUND',
        `The WSL distro "${problem.distro}" is a different installation than the one this repository used.`,
        {
          detail: `Expected registration ${problem.expected}, found ${problem.actual}.`,
          context: { distro: problem.distro }
        }
      )
    case 'unsupported_wsl1':
      return makeAppError(
        'WSL_DISTRO_NOT_FOUND',
        `The WSL distro "${problem.distro}" runs WSL 1, which cannot host a Linux Host.`,
        {
          detail: `Convert it with: wsl --set-version ${problem.distro} 2`,
          context: { distro: problem.distro }
        }
      )
  }
}
