/**
 * A `HarnessDetector` whose evidence comes from the distro, not from Windows.
 *
 * `HarnessDetector` is already dependency-injected (`resolve`, `probe`,
 * `shellPath`), so nothing about the classification logic is reimplemented here:
 * this module only supplies guest-backed implementations of those three, then
 * rewrites the *launch* command so the harness runs under the guest's login
 * shell. Availability evidence and launch shape stay in one place per concern.
 */

import { HARNESS_DEFINITIONS, HARNESS_IDS, type HarnessId } from '../../../shared/domain/harness'
import { HarnessDetector, type HarnessDetectionResult } from '../../harness/harness-detector'
import type { WslCommandRunner } from '../exec'
import {
  guestLaunchSpec,
  probeGuestHarnessVersion,
  resolveGuestExecutables,
  resolveGuestHarnessContext,
  type GuestHarnessContext
} from './guest-harness'

export type GuestHarnessDetectorOptions = {
  runner: WslCommandRunner
  distro: string
  signal?: AbortSignal
  now?: () => number
}

/**
 * Discovers the harnesses for one distro.
 *
 * Every executable is resolved **before** the detector runs, because resolution is
 * async while `HarnessDetector.resolve` is sync. That keeps the classification
 * code untouched and keeps the number of guest calls predictable: one context
 * resolution plus one lookup per harness.
 */
export async function createGuestHarnessDetector(
  options: GuestHarnessDetectorOptions
): Promise<HarnessDetector> {
  const context = await detectContext(options)
  // Names come from the fixed registry (never from user input), and one batched
  // lookup keeps discovery deterministic.
  const names = HARNESS_IDS.flatMap((id) => {
    const command = HARNESS_DEFINITIONS[id].command
    return command.kind === 'executable' ? [command.name] : []
  })
  const resolved = await resolveGuestExecutables({
    runner: options.runner,
    distro: options.distro,
    names,
    shell: context.shell,
    ...(options.signal ? { signal: options.signal } : {})
  })

  return new HarnessDetector({
    // Sync by contract: the map was filled above.
    resolve: (name) => (name.startsWith('/') ? name : (resolved.get(name) ?? null)),
    probe: (file, args) =>
      probeGuestHarnessVersion(
        {
          runner: options.runner,
          distro: options.distro,
          ...(options.signal ? { signal: options.signal } : {})
        },
        file,
        args,
        context.loginPath ?? undefined
      ),
    shellPath: () => context.shell.shell,
    // Guest detection never takes the Windows branch; pinned for clarity.
    platform: 'linux',
    ...(options.now ? { now: options.now } : {})
  })
}

async function detectContext(options: GuestHarnessDetectorOptions): Promise<GuestHarnessContext> {
  return resolveGuestHarnessContext({
    runner: options.runner,
    distro: options.distro,
    ...(options.signal ? { signal: options.signal } : {})
  })
}

/**
 * Rewrites a detection's launch command for the guest.
 *
 * The detector reports the resolved absolute path, which is right for a local
 * target (the host inherits the same environment). In a guest it is not enough:
 * the managed Host is started without a login shell, so a harness installed by
 * nvm/asdf would run without its interpreter on `PATH`. Wrapping it in the login
 * shell is Orca's answer to the same problem, and `exec` keeps the PTY's process
 * the harness itself.
 */
export function withGuestLaunchCommand(
  detection: HarnessDetectionResult,
  context: { shell: GuestHarnessContext['shell'] }
): HarnessDetectionResult {
  if (detection.state !== 'available' || detection.command === null) return detection
  // A WSL *shell* is Path A (`wsl/terminal/path-a.ts`) and never reaches this
  // function: judging it here would be a second implementation of the same
  // terminal. This rewrites coding Agents only.
  return { ...detection, command: guestLaunchSpec(context.shell, detection.resolvedPath) }
}

/** Context probe used by the launch path, which must not re-discover. */
export async function guestHarnessContextFor(
  options: GuestHarnessDetectorOptions
): Promise<GuestHarnessContext> {
  return detectContext(options)
}

/** Re-exported so a caller can name a harness without importing the registry. */
export type { HarnessId }
