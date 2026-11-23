/**
 * Update domain rules shared by main, preload and the renderer.
 *
 * The app reads electron-builder's published metadata rather than the GitHub
 * REST API: the feed is the same one electron-updater consumes, and the
 * release-asset endpoint is not subject to API rate limits.
 */

import { APP_NAME, APP_RELEASE_OWNER, APP_RELEASE_REPO } from './app-identity'

export const UPDATE_MODES = ['install', 'notify', 'unsupported'] as const
export type UpdateMode = (typeof UPDATE_MODES)[number]

export const UPDATE_PHASES = [
  'idle',
  'checking',
  'up-to-date',
  'available',
  'skipped',
  'downloading',
  'ready',
  'restarting',
  'error'
] as const
export type UpdatePhase = (typeof UPDATE_PHASES)[number]

export type UnsupportedUpdateReason = 'not-packaged' | 'unsupported-platform'

export type UpdateModeResolution = {
  mode: UpdateMode
  unsupportedReason: UnsupportedUpdateReason | null
}

/** A deb/rpm install cannot be replaced by the app; it links to the release. */
export function resolveUpdateMode(input: {
  packaged: boolean
  platform: string
  appImage: string | null | undefined
}): UpdateModeResolution {
  if (!input.packaged) {
    return { mode: 'unsupported', unsupportedReason: 'not-packaged' }
  }
  if (input.platform === 'win32') return { mode: 'install', unsupportedReason: null }
  if (input.platform === 'darwin') return { mode: 'notify', unsupportedReason: null }
  if (input.platform === 'linux') {
    return {
      mode: input.appImage ? 'install' : 'notify',
      unsupportedReason: null
    }
  }
  return { mode: 'unsupported', unsupportedReason: 'unsupported-platform' }
}

export type ParsedVersion = {
  major: number
  minor: number
  patch: number
  /** Dot-separated prerelease identifiers; empty for a stable version. */
  prerelease: string[]
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

export function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim())
  if (match === null) return null
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  if (prerelease.some((identifier) => identifier.length === 0)) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease
  }
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left)
  const rightNumeric = /^\d+$/u.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  // A numeric identifier always has lower precedence than an alphanumeric one.
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** Semver precedence for stable and prerelease versions; null when invalid. */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return null
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key])
  }
  // A stable version outranks any prerelease of the same core version.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index]
    const rightIdentifier = b.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    const compared = compareIdentifier(leftIdentifier, rightIdentifier)
    if (compared !== 0) return compared
  }
  return 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const compared = compareVersions(candidate, current)
  return compared !== null && compared > 0
}

export type UpdateMetadataFile = 'latest.yml' | 'latest-linux.yml' | 'latest-mac.yml'

/**
 * The metadata electron-updater reads for this platform. Windows has no
 * platform suffix; Linux x64 has no arch suffix.
 */
export function updateMetadataFileName(platform: string): UpdateMetadataFile | null {
  if (platform === 'win32') return 'latest.yml'
  if (platform === 'linux') return 'latest-linux.yml'
  if (platform === 'darwin') return 'latest-mac.yml'
  return null
}

export function releaseRepositoryUrl(): string {
  return `https://github.com/${APP_RELEASE_OWNER}/${APP_RELEASE_REPO}`
}

export function latestMetadataUrl(platform: string): string | null {
  const fileName = updateMetadataFileName(platform)
  if (fileName === null) return null
  return `${releaseRepositoryUrl()}/releases/latest/download/${fileName}`
}

export function releasePageUrl(version: string): string {
  return `${releaseRepositoryUrl()}/releases/tag/v${version}`
}

export function releaseAssetUrl(version: string, fileName: string): string {
  return `${releaseRepositoryUrl()}/releases/download/v${version}/${encodeURIComponent(fileName)}`
}

export function macDmgFileName(version: string, arch: string): string {
  return `${APP_NAME}-${version}-mac-${arch}.dmg`
}

export function macDmgUrl(version: string, arch: string): string {
  return releaseAssetUrl(version, macDmgFileName(version, arch))
}
