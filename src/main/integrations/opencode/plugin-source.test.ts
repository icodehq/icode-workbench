import { afterEach, describe, expect, it } from 'vitest'
import {
  OPENCODE_PLUGIN_MARKER,
  openCodeServerPluginSource,
  openCodeTuiPluginSource
} from './plugin-source'

const previous = process.env.ICODE_OPENCODE_PLUGIN_API

afterEach(() => {
  if (previous === undefined) delete process.env.ICODE_OPENCODE_PLUGIN_API
  else process.env.ICODE_OPENCODE_PLUGIN_API = previous
})

async function load(source: string, suffix: string): Promise<Record<string, unknown>> {
  const encoded = Buffer.from(source, 'utf8').toString('base64')
  return (await import(`data:text/javascript;base64,${encoded}#${suffix}`)) as Record<
    string,
    unknown
  >
}

describe('generated OpenCode plugins', () => {
  it('carries the ownership marker and loads as a 1.x factory by default', async () => {
    const source = openCodeServerPluginSource()
    expect(source.startsWith(OPENCODE_PLUGIN_MARKER)).toBe(true)
    delete process.env.ICODE_OPENCODE_PLUGIN_API
    const module = await load(source, 'v1')
    expect(typeof module.default).toBe('function')
  })

  it('loads the 2.x server/setup object when the launch env selects v2', async () => {
    process.env.ICODE_OPENCODE_PLUGIN_API = 'v2'
    const module = await load(openCodeServerPluginSource(), 'v2')
    const plugin = module.default as { id?: string; server?: unknown; setup?: unknown }
    expect(plugin.id).toBe('icode-opencode-status')
    expect(typeof plugin.server).toBe('function')
    expect(typeof plugin.setup).toBe('function')
  })

  it('exports a TUI-only object without server() for the 1.x loader', async () => {
    const module = await load(openCodeTuiPluginSource(), 'tui')
    const plugin = module.default as Record<string, unknown>
    expect(plugin.id).toBe('icode-opencode-status-tui')
    expect(typeof plugin.tui).toBe('function')
    expect(typeof plugin.setup).toBe('function')
    expect('server' in plugin).toBe(false)
  })

  it('is inert without the PTY identity and token', async () => {
    delete process.env.ICODE_SESSION_ID
    delete process.env.ICODE_HOST_SOCKET
    const module = await load(openCodeServerPluginSource(), 'inert')
    const factory = module.default as (ctx: unknown) => Promise<{ event: unknown }>
    const hooks = await factory({})
    expect(typeof hooks.event).toBe('function')
  })
})
