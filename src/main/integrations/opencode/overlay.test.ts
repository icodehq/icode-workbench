import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mirrorOpenCodeConfig,
  overlayDirFor,
  overlayOwnedBy,
  removeOpenCodeOverlay
} from './overlay'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'icode-opencode-overlay-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('OpenCode custom-config overlay', () => {
  it('mirrors user plugins and tui.json without writing to the source', async () => {
    const source = join(root, 'custom', 'opencode')
    const userData = join(root, 'profile')
    mkdirSync(join(source, 'plugins'), { recursive: true })
    writeFileSync(join(source, 'plugins', 'user.js'), 'user plugin')
    writeFileSync(join(source, 'tui.json'), '{"plugin":["user-tui"]}\n')
    const overlay = overlayDirFor(userData, source)

    await mirrorOpenCodeConfig(source, overlay, 1)

    expect(readFileSync(join(source, 'plugins', 'user.js'), 'utf8')).toBe('user plugin')
    expect(readFileSync(join(overlay, 'plugins', 'user.js'), 'utf8')).toBe('user plugin')
    expect(readFileSync(join(overlay, 'tui.json'), 'utf8')).toBe('{"plugin":["user-tui"]}\n')
    await expect(overlayOwnedBy(overlay, source)).resolves.toBe(true)
  })

  it('refreshes an existing overlay and removes only an owned one', async () => {
    const source = join(root, 'custom', 'opencode')
    const userData = join(root, 'profile')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'config.json'), '{}')
    const overlay = overlayDirFor(userData, source)

    await mirrorOpenCodeConfig(source, overlay, 1)
    await mirrorOpenCodeConfig(source, overlay, 2)
    expect(JSON.parse(readFileSync(join(overlay, '.icode-opencode-overlay.json'), 'utf8'))).toMatchObject(
      { version: 1, sourceConfigDir: source, createdAt: 1 }
    )

    await removeOpenCodeOverlay(overlay, source)
    await expect(overlayOwnedBy(overlay, source)).resolves.toBe(false)
  })

  it('refuses an unknown directory at the overlay path', async () => {
    const source = join(root, 'custom', 'opencode')
    const userData = join(root, 'profile')
    mkdirSync(source, { recursive: true })
    const overlay = overlayDirFor(userData, source)
    mkdirSync(overlay, { recursive: true })
    writeFileSync(join(overlay, 'user-file'), 'keep me')

    await expect(mirrorOpenCodeConfig(source, overlay)).rejects.toThrow(/unknown directory/)
    expect(readFileSync(join(overlay, 'user-file'), 'utf8')).toBe('keep me')
  })
})
