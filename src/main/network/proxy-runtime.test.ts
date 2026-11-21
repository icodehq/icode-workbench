import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_PREFERENCES,
  type AppPreferences
} from '../app/preferences'
import type { ChromiumProxyConfig } from './proxy-environment'
import { createNetworkProxyRuntime, type ProxySession } from './proxy-runtime'
import type { NetworkProxySettings } from '../../shared/domain/network'

type SessionCalls = {
  configs: ChromiumProxyConfig[]
  resolved: string[]
  reloaded: number
  closed: number
  fetched: string[]
}

function fakeSession(resolved: Record<string, string> = {}): {
  session: ProxySession
  calls: SessionCalls
} {
  const calls: SessionCalls = {
    configs: [],
    resolved: [],
    reloaded: 0,
    closed: 0,
    fetched: []
  }
  return {
    calls,
    session: {
      async setProxy(config) {
        calls.configs.push(config)
      },
      async resolveProxy(url) {
        calls.resolved.push(url)
        return resolved[url] ?? 'DIRECT'
      },
      async forceReloadProxyConfig() {
        calls.reloaded += 1
      },
      async closeAllConnections() {
        calls.closed += 1
      },
      async fetch(url) {
        calls.fetched.push(url)
        return new Response('ok')
      }
    }
  }
}

function fakePreferences(initial: AppPreferences = DEFAULT_APP_PREFERENCES): {
  load: () => AppPreferences
  save: (directory: string, patch: Partial<AppPreferences>) => boolean
  value: () => AppPreferences
  setSaveResult: (result: boolean) => void
} {
  let value = structuredClone(initial)
  let saveResult = true
  return {
    load: () => value,
    save: (_directory, patch) => {
      if (saveResult) value = { ...value, ...patch }
      return saveResult
    },
    value: () => value,
    setSaveResult: (result) => {
      saveResult = result
    }
  }
}

const manual: NetworkProxySettings = {
  mode: 'manual',
  httpProxyUrl: 'http://127.0.0.1:7890',
  httpsProxyUrl: 'http://127.0.0.1:7890',
  noProxy: 'corp.example'
}

async function runtimeFor(
  options: {
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    resolved?: Record<string, string>
    prefs?: ReturnType<typeof fakePreferences>
    probeWsl?: (distro: string) => Promise<{ mode: 'nat' | 'mirrored' | 'unknown'; gateway: string | null }>
  } = {}
) {
  const env = options.env ?? {}
  const { session, calls } = fakeSession(options.resolved)
  const prefs = options.prefs ?? fakePreferences()
  const runtime = await createNetworkProxyRuntime({
    directory: '/tmp/icode-proxy-test',
    session,
    env,
    platform: options.platform ?? 'linux',
    resolveTimeoutMs: 50,
    loadPreferences: prefs.load,
    savePreferences: prefs.save,
    ...(options.probeWsl === undefined ? {} : { probeWsl: options.probeWsl })
  })
  return { runtime, session, calls, env, prefs }
}

describe('network proxy runtime', () => {
  it('keeps inherited values and emits both spellings on POSIX', async () => {
    const { calls, env } = await runtimeFor({
      env: {
        http_proxy: 'http://env:1',
        HTTPS_PROXY: 'http://env:2',
        NO_PROXY: 'corp.example'
      }
    })
    expect(calls.configs).toEqual([{ mode: 'system' }])
    expect(calls.resolved).toEqual([])
    expect(env.http_proxy).toBe('http://env:1')
    expect(env.HTTP_PROXY).toBe('http://env:1')
    expect(env.https_proxy).toBe('http://env:2')
    expect(env.HTTPS_PROXY).toBe('http://env:2')
    expect(env.no_proxy).toBe('corp.example,localhost,127.0.0.1,::1')
    expect(env.NO_PROXY).toBe('corp.example,localhost,127.0.0.1,::1')
  })

  it('fills a missing system scheme from Chromium', async () => {
    const { calls, env } = await runtimeFor({
      resolved: {
        'http://example.com/': 'PROXY 127.0.0.1:7890',
        'https://example.com/': 'SOCKS5 127.0.0.1:1080'
      }
    })
    expect(calls.reloaded).toBe(1)
    expect(calls.resolved).toEqual(['http://example.com/', 'https://example.com/'])
    expect(env.http_proxy).toBe('http://127.0.0.1:7890')
    expect(env.https_proxy).toBe('socks5h://127.0.0.1:1080')
  })

  it('applies and persists manual settings', async () => {
    const prefs = fakePreferences()
    const { runtime, calls, env } = await runtimeFor({ prefs })
    await runtime.saveSettings(manual)
    expect(prefs.value().proxy).toEqual(manual)
    expect(calls.configs.at(-1)).toEqual({
      mode: 'fixed_servers',
      proxyRules:
        'http=127.0.0.1:7890;https=127.0.0.1:7890',
      proxyBypassRules: 'corp.example,localhost,127.0.0.1,::1'
    })
    expect(env.http_proxy).toBe('http://127.0.0.1:7890')
    expect(runtime.settings()).toEqual(manual)
  })

  it('scrubs proxy variables in off mode', async () => {
    const { runtime, env } = await runtimeFor({
      env: { http_proxy: 'http://env:1', HTTPS_PROXY: 'http://env:2' }
    })
    await runtime.saveSettings({ ...manual, mode: 'off' })
    expect(env.http_proxy).toBeUndefined()
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.https_proxy).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.no_proxy).toBeUndefined()
  })

  it('uses lowercase only for local Windows sessions', async () => {
    const { runtime } = await runtimeFor({ platform: 'win32' })
    await runtime.saveSettings(manual)
    expect(runtime.localSessionEnv()).toEqual({
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      no_proxy: 'corp.example,localhost,127.0.0.1,::1'
    })
  })

  it('returns both cases for a WSL guest session', async () => {
    const { runtime } = await runtimeFor()
    await runtime.saveSettings(manual)
    expect(await runtime.guestSessionEnv('Ubuntu')).toMatchObject({
      http_proxy: 'http://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890'
    })
  })

  it('rejects invalid settings before persisting', async () => {
    const { runtime, prefs } = await runtimeFor()
    await expect(
      runtime.saveSettings({
        mode: 'manual',
        httpProxyUrl: 'http://host',
        httpsProxyUrl: '',
        noProxy: ''
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(prefs.value().proxy.mode).toBe('system')
  })

  it('reports a failed write and leaves behavior unchanged', async () => {
    const { runtime, prefs } = await runtimeFor()
    prefs.setSaveResult(false)
    await expect(runtime.saveSettings(manual)).rejects.toMatchObject({ code: 'INTERNAL' })
    expect(runtime.settings().mode).toBe('system')
  })

  it('falls back to system when persisted manual settings are invalid', async () => {
    const prefs = fakePreferences({
      ...DEFAULT_APP_PREFERENCES,
      proxy: { ...manual, httpProxyUrl: 'http://host' }
    })
    const { runtime } = await runtimeFor({ prefs })
    expect(runtime.settings().mode).toBe('system')
  })

  it('delegates fetches to the configured session', async () => {
    const { runtime, calls } = await runtimeFor()
    await runtime.fetch('https://example.com/')
    expect(calls.fetched).toEqual(['https://example.com/'])
  })

  it('rewrites a loopback proxy to the WSL NAT gateway', async () => {
    const { runtime } = await runtimeFor({
      platform: 'win32',
      probeWsl: async () => ({ mode: 'nat', gateway: '172.22.48.1' })
    })
    await runtime.saveSettings(manual)
    expect(await runtime.guestSessionEnv('Ubuntu')).toMatchObject({
      HTTP_PROXY: 'http://172.22.48.1:7890',
      http_proxy: 'http://172.22.48.1:7890',
      NO_PROXY: 'corp.example,localhost,127.0.0.1,::1'
    })
  })

  it('leaves localhost untouched in WSL mirrored mode', async () => {
    const { runtime } = await runtimeFor({
      platform: 'win32',
      probeWsl: async () => ({ mode: 'mirrored', gateway: null })
    })
    await runtime.saveSettings(manual)
    expect(await runtime.guestSessionEnv('Ubuntu')).toMatchObject({
      HTTP_PROXY: 'http://127.0.0.1:7890'
    })
  })

  it('does not rewrite when the networking mode is unknown', async () => {
    const { runtime } = await runtimeFor({
      platform: 'win32',
      probeWsl: async () => ({ mode: 'unknown', gateway: null })
    })
    await runtime.saveSettings(manual)
    expect(await runtime.guestSessionEnv('Ubuntu')).toMatchObject({
      HTTP_PROXY: 'http://127.0.0.1:7890'
    })
  })

  it('caches the WSL network probe and clears it on save', async () => {
    let calls = 0
    const { runtime } = await runtimeFor({
      platform: 'win32',
      probeWsl: async () => {
        calls += 1
        return { mode: 'mirrored', gateway: null }
      }
    })
    await runtime.saveSettings(manual)
    await runtime.guestSessionEnv('Ubuntu')
    await runtime.guestSessionEnv('ubuntu')
    expect(calls).toBe(1)
    await runtime.saveSettings(manual)
    await runtime.guestSessionEnv('Ubuntu')
    expect(calls).toBe(2)
  })

  it('clears guest proxy variables in off mode', async () => {
    const { runtime } = await runtimeFor({ platform: 'win32' })
    await runtime.saveSettings({ ...manual, mode: 'off' })
    expect(await runtime.guestSessionEnv('Ubuntu')).toEqual({
      HTTP_PROXY: '',
      http_proxy: '',
      HTTPS_PROXY: '',
      https_proxy: '',
      NO_PROXY: '',
      no_proxy: '',
      ALL_PROXY: '',
      all_proxy: ''
    })
  })

  it('does not probe WSL on a non-Windows host', async () => {
    let calls = 0
    const { runtime } = await runtimeFor({
      platform: 'linux',
      probeWsl: async () => {
        calls += 1
        return { mode: 'nat', gateway: '172.22.48.1' }
      }
    })
    await runtime.saveSettings(manual)
    expect(await runtime.guestSessionEnv('Ubuntu')).toMatchObject({
      HTTP_PROXY: 'http://127.0.0.1:7890'
    })
    expect(calls).toBe(0)
  })
})
