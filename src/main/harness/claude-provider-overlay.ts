import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withClaudeProviderEnv } from '../../shared/provider-launch'

/**
 * Fallback-only Claude delivery.
 *
 * The primary path puts ANTHROPIC_* in the PTY environment. This materializer
 * exists in case a measured Claude version ignores the process env but honors a
 * `--settings` overlay. It writes one content-addressed 0600 document containing
 * the hook overlay plus the provider env, so a running session's file is never
 * overwritten by a later switch.
 *
 * The key is in this file. It is only used when CLAUDE_PROVIDER_DELIVERY is
 * flipped to `settings-overlay`; the caller prunes old files.
 */
export function materializeClaudeProviderOverlay(options: {
  baseSettingsPath: string
  directory: string
  env: Record<string, string>
}): string {
  const base = JSON.parse(readFileSync(options.baseSettingsPath, 'utf8')) as Record<
    string,
    unknown
  >
  const bytes = `${JSON.stringify(withClaudeProviderEnv(base, options.env), null, 2)}\n`
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  const path = join(options.directory, `provider-claude-${hash}.json`)
  writeFileSync(path, bytes, { mode: 0o600 })
  return path
}

/** Best-effort retention for key-bearing fallback overlays. */
export function pruneClaudeProviderOverlays(
  directory: string,
  now: number,
  maxAgeMs = 24 * 60 * 60 * 1000
): void {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith('provider-claude-') || !entry.endsWith('.json')) continue
    const path = join(directory, entry)
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { force: true })
    } catch {
      // A concurrent delete or a permission error is not worth failing startup.
    }
  }
}
