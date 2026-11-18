import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveOpenCodeConfigDir } from './config-dir'

describe('OpenCode config directory', () => {
  it('honours an explicit OPENCODE_CONFIG_DIR only when asked', () => {
    expect(
      resolveOpenCodeConfigDir({
        env: { OPENCODE_CONFIG_DIR: '/custom/opencode' },
        home: '/home/dev',
        platform: 'linux'
      })
    ).toBe('/custom/opencode')
    expect(
      resolveOpenCodeConfigDir({
        env: { OPENCODE_CONFIG_DIR: '/custom/opencode' },
        home: '/home/dev',
        platform: 'linux',
        honorConfigDir: false
      })
    ).toBe(join('/home/dev', '.config', 'opencode'))
  })

  it('uses an absolute XDG_CONFIG_HOME before the home fallback', () => {
    expect(
      resolveOpenCodeConfigDir({
        env: { XDG_CONFIG_HOME: '/xdg' },
        home: '/home/dev',
        platform: 'linux'
      })
    ).toBe(join('/xdg', 'opencode'))
    expect(
      resolveOpenCodeConfigDir({
        env: { XDG_CONFIG_HOME: 'relative' },
        home: '/home/dev',
        platform: 'linux'
      })
    ).toBe(join('/home/dev', '.config', 'opencode'))
  })

  it('uses USERPROFILE on Windows and HOME elsewhere', () => {
    expect(
      resolveOpenCodeConfigDir({
        env: { USERPROFILE: 'C:\\Users\\dev', XDG_CONFIG_HOME: 'C:\\xdg' },
        home: '/ignored',
        platform: 'win32'
      })
    ).toBe(join('C:\\Users\\dev', '.config', 'opencode'))
    expect(
      resolveOpenCodeConfigDir({
        env: { HOME: '/home/dev' },
        home: '/ignored',
        platform: 'darwin'
      })
    ).toBe(join('/home/dev', '.config', 'opencode'))
  })
})
