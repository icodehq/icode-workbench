/**
 * Where the W3 Linux Host tree lives, and its manifest.
 *
 * The tree is gitignored build output, so a missing one must fail with an
 * actionable message rather than a `JSON.parse` of `undefined`. The paths are the
 * two that actually exist: the repository during development, and the packaged
 * resources directory.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { makeAppError, type AppError } from '../../../shared/domain/errors'
import { parseHostArtifactManifest, type HostArtifactManifest } from './deploy'

/** `linux-x64` is the only architecture W3 builds; the manifest states it too. */
const ARTIFACT_DIRECTORY = join('wsl-host', 'linux-x64')

export function wslArtifactRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'artifacts', ARTIFACT_DIRECTORY)
    : join(app.getAppPath(), 'artifacts', ARTIFACT_DIRECTORY)
}

export type WslArtifactLoad =
  | { ok: true; root: string; manifest: HostArtifactManifest }
  | { ok: false; error: AppError; root: string }

/**
 * Reads and validates the manifest once.
 *
 * The caller supplies the cached result to every lifecycle it builds, so one
 * broken artifact tree is reported identically wherever it is used.
 */
export function loadWslArtifacts(): WslArtifactLoad {
  const root = wslArtifactRoot()
  let text: string
  try {
    text = readFileSync(join(root, 'manifest.json'), 'utf8')
  } catch (error) {
    return {
      ok: false,
      root,
      error: makeAppError(
        'WSL_HOST_DEPLOY_FAILED',
        'The Linux Host artifacts are missing.',
        {
          detail:
            error instanceof Error
              ? `${root}: ${error.message}`
              : `${root}: the manifest could not be read.`
        }
      )
    }
  }
  const manifest = parseHostArtifactManifest(text)
  if (manifest === null) {
    return {
      ok: false,
      root,
      error: makeAppError(
        'WSL_HOST_DEPLOY_FAILED',
        'The Linux Host artifact manifest is not valid.',
        { detail: join(root, 'manifest.json') }
      )
    }
  }
  return { ok: true, root, manifest }
}
