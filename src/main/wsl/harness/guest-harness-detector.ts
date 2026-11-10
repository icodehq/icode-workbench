/**
 * A `HarnessDetector` whose evidence comes from the distro, not from Windows.
 *
 * `HarnessDetector` is already dependency-injected (`resolve`, `probe`,
 * `shellPath`), so nothing about the classification logic is reimplemented here:
 * this module only supplies guest-backed implementations of those three, then
 * rewrites the *launch* command so the harness runs under the guest's login
 * shell. Availability evidence and launch shape stay in one place per concern.
 */

import type { HarnessId } from '../../../shared/domain/harness'
import { HarnessDetector, type HarnessDetectionResult } from '../../harness/harness-detector'
import type { WslCommandRunner } from '../exec'
import {
  guestLaunchSpec,
  probeGuestHarnessVersion,
  resolveGuestHarnessContext,
  resolveGuestHarnessSnapshot,
  type GuestHarnessContext,
  type GuestHarnessSnapshot
} from './guest-harness'

export type GuestHarnessDetectorOptions = {
  runner: WslCommandRunner
  distro: string
  signal?: AbortSignal
  now?: () => number
  /**
   * A snapshot already resolved for this distro. Supplying it removes the shell,
   * login-PATH and executable-lookup spawns; only the version probe remains.
   */
  probe?: GuestHarnessSnapshot
}

export type GuestHarnessDetectorBundle = {
  detector: HarnessDetector
  /** The context this detector resolved (or was handed), so callers do not re-probe. */
  context: GuestHarnessContext
}

/**
 * Discovers the harnesses for one distro.
 *
 * Every executable is resolved **before** the detector runs, because resolution is
 * async while `HarnessDetector.resolve` is sync. The snapshot is either supplied
 * by the probe cache or resolved once here; the same context is returned so the
 * launch-command rewrite does not ask the guest a second time.
 */
export async function createGuestHarnessDetector(
  options: GuestHarnessDetectorOptions
): Promise<GuestHarnessDetectorBundle> {
  const snapshot =
    options.probe ??
    (await resolveGuestHarnessSnapshot({
      runner: options.runner,
      distro: options.distro,
      ...(options.signal ? { signal: options.signal } : {})
    }))
  const context: GuestHarnessContext = {
    shell: snapshot.shell,
    loginPath: snapshot.loginPath
  }

  const detector = new HarnessDetector({
    // Sync by contract: the snapshot was filled before the detector runs.
    resolve: (name) =>
      name.startsWith('/') ? name : (snapshot.executables.get(name) ?? null),
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
  return { detector, context }
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
  return resolveGuestHarnessContext({
    runner: options.runner,
    distro: options.distro,
    ...(options.signal ? { signal: options.signal } : {})
  })
}

/** Re-exported so a caller can name a harness without importing the registry. */
export type { HarnessId }
