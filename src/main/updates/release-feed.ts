import { parse as parseYaml } from 'yaml'
import { makeAppError, type AppError } from '../../shared/domain/errors'
import {
  isNewerVersion,
  latestMetadataUrl,
  macDmgUrl,
  parseVersion,
  releasePageUrl,
  updateMetadataFileName,
  type UpdateMode
} from '../../shared/domain/update'

/**
 * Reads electron-builder's published update metadata for this platform.
 *
 * The metadata is the same feed electron-updater consumes, so installs and
 * notifications agree on the latest version. Reading the release asset instead
 * of the GitHub REST API also avoids the per-IP API rate limit.
 */

export type ReleaseFeedDeps = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  platform: string
  arch: string
  /**
   * Test/mirror override for the release-asset base URL (http/https only).
   * Production leaves it null and reads the public GitHub release.
   */
  feedBaseUrl?: string | null
  /** Bound on the metadata request, including reading the response body. */
  timeoutMs?: number
  now?: () => number
}

export type ReleaseCheckResult =
  | { status: 'up-to-date'; checkedAt: number }
  | {
      status: 'available'
      checkedAt: number
      version: string
      releaseUrl: string
      /** Browser download URL for notify-only platforms; null for installs. */
      downloadUrl: string | null
    }

export type ReleaseFeed = {
  check(currentVersion: string, mode: UpdateMode): Promise<ReleaseCheckResult>
}

function checkFailed(detail: string): AppError {
  return makeAppError('UPDATE_CHECK_FAILED', 'Could not check for updates.', {
    detail,
    messageKey: 'updates.error.checkFailed'
  })
}

function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { retryable?: unknown }).retryable === 'boolean'
  )
}

const DEFAULT_TIMEOUT_MS = 15_000

export function createReleaseFeed(deps: ReleaseFeedDeps): ReleaseFeed {
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async check(currentVersion, mode) {
      const base = deps.feedBaseUrl?.replace(/\/+$/u, '')
      const metadataFile = updateMetadataFileName(deps.platform)
      const metadataUrl =
        base !== undefined && base !== null && metadataFile !== null
          ? `${base}/${metadataFile}`
          : latestMetadataUrl(deps.platform)
      if (metadataUrl === null) {
        throw checkFailed(`No update feed exists for ${deps.platform}.`)
      }

      const url = `${metadataUrl}?noCache=${now()}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      let text: string
      try {
        response = await deps.fetch(url, {
          // The query string is the cache-buster; `cache` is not consistently
          // honored by Electron's session fetch.
          headers: { accept: 'application/x-yaml, text/yaml, text/plain, */*' },
          signal: controller.signal
        })
        if (!response.ok) {
          throw checkFailed(`The update feed responded with HTTP ${response.status}.`)
        }
        try {
          text = await response.text()
        } catch (error) {
          if (controller.signal.aborted) {
            throw checkFailed(`The update feed timed out after ${timeoutMs}ms.`)
          }
          throw checkFailed(error instanceof Error ? error.message : String(error))
        }
      } catch (error) {
        if (isAppError(error)) throw error
        if (controller.signal.aborted) {
          throw checkFailed(`The update feed timed out after ${timeoutMs}ms.`)
        }
        throw checkFailed(error instanceof Error ? error.message : String(error))
      } finally {
        clearTimeout(timer)
      }

      let version: string
      try {
        const parsed: unknown = parseYaml(text)
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          typeof (parsed as Record<string, unknown>).version !== 'string'
        ) {
          throw new Error('The update feed has no version.')
        }
        version = (parsed as { version: string }).version
      } catch (error) {
        throw checkFailed(error instanceof Error ? error.message : String(error))
      }

      const parsedVersion = parseVersion(version)
      if (parsedVersion === null || parsedVersion.prerelease.length > 0) {
        throw checkFailed(`The update feed reported an invalid stable version: ${version}`)
      }

      const checkedAt = now()
      if (!isNewerVersion(version, currentVersion)) {
        return { status: 'up-to-date', checkedAt }
      }

      return {
        status: 'available',
        checkedAt,
        version,
        releaseUrl: releasePageUrl(version),
        downloadUrl:
          mode === 'notify'
            ? deps.platform === 'darwin'
              ? macDmgUrl(version, deps.arch)
              : releasePageUrl(version)
            : null
      }
    }
  }
}
