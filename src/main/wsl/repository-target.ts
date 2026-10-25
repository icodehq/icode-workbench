/**
 * The one adapter between W1's `ExecutionTarget` and W2's distro validation.
 *
 * Trust boundary, decided once and documented here so no layer has to guess:
 *
 *   - **Acceptance** (`RepositoryService.addRepository`) validates a target
 *     exactly once, before it is persisted, and stores the *proven* form: the
 *     registry's spelling of the name plus the registration id it resolved.
 *     That is the only point a caller-supplied target enters the database, so
 *     no other layer validates on the way in.
 *   - **Reads** (`listRepositories`, `getRepository`) never validate. A stopped
 *     or removed distro must not make a registered repository unopenable; the
 *     UI needs to show it *in order to* offer a repair.
 *   - **Launch** (W4: `HostSupervisor.ensure`) revalidates the persisted target
 *     before a managed Host consumes it, because a row can outlive its
 *     registration. It calls this same function — there is no second validator.
 *
 * Local targets pass through without any OS call, which is what keeps every
 * pre-WSL code path byte-identical in behaviour and cost.
 */

import type { AppError } from '../../shared/domain/errors'
import {
  isLocalTarget,
  type ExecutionTarget,
  type WslExecutionTarget
} from '../../shared/domain/repository'
import { discoverWslDistros, type WslDistroDiscoveryDeps } from './distros'
import { WslCommandRunner } from './exec'
import { validateWslTargetAgainst, wslTargetProblemToAppError } from './target-validation'

/**
 * A rejected target, carrying the app error the caller should surface.
 *
 * The dispatcher already maps any error exposing `appError`, so this needs no
 * new branch there; it exists so callers above persistence can distinguish a
 * rejected target from an unexpected failure without parsing messages.
 */
export class RepositoryTargetError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'RepositoryTargetError'
  }
}

/** Local passes through; WSL returns the canonical, proven target or throws. */
export type TargetValidator = (target: ExecutionTarget) => Promise<ExecutionTarget>

/**
 * How a target is judged: `discovery` injects the WSL seam, so a test can
 * supply a registry dump and a fake launcher without touching this module.
 */
export function createTargetValidator(discovery?: WslDistroDiscoveryDeps): TargetValidator {
  return async (target) => {
    if (isLocalTarget(target)) return target

    const deps: WslDistroDiscoveryDeps = discovery ?? { runner: new WslCommandRunner() }
    const discoveryResult = await discoverWslDistros(deps)
    const validation = validateWslTargetAgainst(target, discoveryResult)
    if (!validation.ok) {
      throw new RepositoryTargetError(wslTargetProblemToAppError(validation.problem))
    }
    // Prefer the proven form: `wsl.exe -d` wants the registry spelling, and the
    // id it resolved is what later revalidation and rename-dedupe rely on.
    return validation.target
  }
}

/**
 * Revalidates a persisted target for the launch boundary (W4).
 *
 * Distinct from acceptance in one way that matters: it takes the record's
 * `executionTarget` as already stored, including a `null` id written before an
 * id could be read, and returns the canonical target W4 should launch against.
 * A local repository yields `null` — there is no distro to launch into.
 */
export async function revalidateRepositoryTarget(
  target: ExecutionTarget,
  validate: TargetValidator
): Promise<WslExecutionTarget | null> {
  const canonical = await validate(target)
  return canonical.kind === 'wsl' ? canonical : null
}

