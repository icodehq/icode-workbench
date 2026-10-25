/**
 * The same file, spelled so a Guest process can open it.
 *
 * ADE keeps its activity hooks beside its own Windows user data, so the generated
 * `--settings` value is a Windows path like `D:\…\agent-hooks\settings.json`. A
 * distro cannot open that string: as far as Linux is concerned it is a relative
 * file name containing backslashes. WSL exposes Windows drives at `/mnt/<letter>`,
 * so the guest spelling is `/mnt/d/…/settings.json`.
 *
 * Only absolute drive paths are rewritten. Anything else is returned unchanged, so
 * a caller never gets a plausible-looking but invented path.
 */

const DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/u

export function toGuestVisiblePath(windowsPath: string): string {
  const match = DRIVE_PATH.exec(windowsPath)
  if (match === null) return windowsPath
  const drive = match[1]!.toLowerCase()
  const rest = match[2]!.replace(/\\/g, '/')
  return `/mnt/${drive}/${rest}`
}
