/**
 * The distro list, as the renderer may see it.
 *
 * `discoverWslDistros` is the W2 contract and stays the only discovery logic;
 * this module only maps its result onto the IPC payload. Keeping the mapping
 * separate means the UI-facing shape can be tested without Electron or WSL, and
 * that a reader can see exactly which fields cross the boundary.
 *
 * Two things deliberately survive the mapping:
 *
 *   - **`unavailable` stays `unavailable`.** It is not an error and not an empty
 *     list. On a machine without WSL, the repository dialog must still offer
 *     local repositories, and must not imply "no distros installed".
 *   - **`running: null` stays `null`.** A failed running probe is unknown, not
 *     "stopped"; the terminal starts the distro either way.
 */

import type { WslDistroListPayload } from '../../shared/schemas/ipc'
import type { WslDistroDiscovery } from './distros'

export function toWslDistroListPayload(discovery: WslDistroDiscovery): WslDistroListPayload {
  if (discovery.status === 'unavailable') {
    return {
      status: 'unavailable',
      reason: discovery.reason,
      detail: discovery.detail
    }
  }
  return {
    status: 'ok',
    distros: discovery.distros.map((distro) => ({
      name: distro.name,
      registrationId: distro.registrationId,
      version: distro.version,
      running: distro.running
    })),
    defaultRegistrationId: discovery.defaultRegistrationId
  }
}
