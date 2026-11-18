import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const MANIFEST = '.icode-opencode-overlay.json'
const MANIFEST_VERSION = 1
const OWNED_NAMES = new Set(['icode-opencode-status.js', 'icode-opencode-status-tui'])

export type OverlayManifest = {
  version: 1
  sourceConfigDir: string
  createdAt: number
}

export function overlayDirFor(userDataDir: string, sourceConfigDir: string): string {
  const hash = createHash('sha256').update(sourceConfigDir).digest('hex').slice(0, 32)
  return join(userDataDir, 'opencode-config-overlays', hash)
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readManifest(directory: string): Promise<OverlayManifest | null> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(join(directory, MANIFEST), 'utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    if (
      record.version !== MANIFEST_VERSION ||
      typeof record.sourceConfigDir !== 'string' ||
      typeof record.createdAt !== 'number'
    ) {
      return null
    }
    return {
      version: MANIFEST_VERSION,
      sourceConfigDir: record.sourceConfigDir,
      createdAt: record.createdAt
    }
  } catch {
    return null
  }
}

async function mirrorEntry(source: string, target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true })
  const directory = (await fs.stat(source)).isDirectory()
  try {
    await fs.symlink(source, target, directory ? 'junction' : 'file')
  } catch {
    // Windows may require developer mode for symlinks; copying is still safe.
    await fs.cp(source, target, { recursive: true, force: true })
  }
}

/**
 * Mirrors a custom config directory into an app-owned overlay.
 *
 * `plugins/` stays a real directory so iCode can add its files beside the user's
 * plugins; every other entry is a link (copy fallback). `tui.json` is copied so
 * registration never mutates the source config.
 */
export async function mirrorOpenCodeConfig(
  sourceConfigDir: string,
  overlayDir: string,
  now = Date.now()
): Promise<void> {
  if (!(await exists(sourceConfigDir))) {
    throw new Error('The custom OpenCode config directory does not exist.')
  }
  const previous = await readManifest(overlayDir)
  if (previous !== null && previous.sourceConfigDir !== sourceConfigDir) {
    throw new Error('The overlay belongs to a different OpenCode config directory.')
  }
  if (previous === null && (await exists(overlayDir))) {
    const entries = await fs.readdir(overlayDir).catch(() => [])
    if (entries.length > 0) {
      throw new Error('An unknown directory already uses the overlay path.')
    }
  }
  await fs.mkdir(overlayDir, { recursive: true, mode: 0o700 })
  const sourceEntries = await fs.readdir(sourceConfigDir, { withFileTypes: true })
  for (const entry of sourceEntries) {
    if (entry.name === 'plugins') {
      await fs.mkdir(join(overlayDir, 'plugins'), { recursive: true, mode: 0o700 })
      const plugins = await fs.readdir(join(sourceConfigDir, 'plugins'), {
        withFileTypes: true
      })
      for (const plugin of plugins) {
        if (OWNED_NAMES.has(plugin.name)) continue
        await mirrorEntry(
          join(sourceConfigDir, 'plugins', plugin.name),
          join(overlayDir, 'plugins', plugin.name)
        )
      }
      continue
    }
    if (entry.name === MANIFEST) continue
    const sourcePath = join(sourceConfigDir, entry.name)
    const targetPath = join(overlayDir, entry.name)
    if (entry.name === 'tui.json' || entry.name === 'tui.jsonc') {
      await fs.copyFile(sourcePath, targetPath)
      continue
    }
    await mirrorEntry(sourcePath, targetPath)
  }
  await fs.writeFile(
    join(overlayDir, MANIFEST),
    JSON.stringify(
      {
        version: MANIFEST_VERSION,
        sourceConfigDir,
        createdAt: previous?.createdAt ?? now
      } satisfies OverlayManifest,
      null,
      2
    ) + '\n',
    { encoding: 'utf8', mode: 0o600 }
  )
}

export async function overlayOwnedBy(
  overlayDir: string,
  sourceConfigDir: string
): Promise<boolean> {
  const manifest = await readManifest(overlayDir)
  return manifest !== null && manifest.sourceConfigDir === sourceConfigDir
}

/** Removes only an overlay whose manifest proves iCode created it. */
export async function removeOpenCodeOverlay(
  overlayDir: string,
  sourceConfigDir: string
): Promise<void> {
  if (!(await overlayOwnedBy(overlayDir, sourceConfigDir))) return
  await fs.rm(overlayDir, { recursive: true, force: true })
}
