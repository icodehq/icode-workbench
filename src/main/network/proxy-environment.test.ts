import { describe, expect, it } from 'vitest'
import type { NetworkProxySettings } from '../../shared/domain/network'
import {
  captureInheritedProxy,
  chromiumProxyConfig,
  effectiveProxyUrls,
  emittedProxyEnv,
  guestEnvAssignments,
  guestProxyEnv,
  isLoopbackProxyHost,
  parseResolveProxyResult,
  rewriteLoopbackProxyUrl
} from './proxy-environment'

const manual: NetworkProxySettings = {
  mode: 'manual',
  httpProxyUrl: 'http://127.0.0.1:7890',
  httpsProxyUrl: 'http://127.0.0.1:7890',
  noProxy: 'corp.example'
}

describe('inherited proxy capture', () => {
  it('prefers lowercase and falls back to uppercase', () => {
    expect(
      captureInheritedProxy({
        http_proxy: 'http://lower:1',
        HTTPS_PROXY: 'http://upper:2',
        NO_PROXY: 'corp.example',
        ALL_PROXY: 'socks5://all:3'
      })
    ).toEqual({
      http: 'http://lower:1',
      https: 'http://upper:2',
      noProxy: 'corp.example',
      all: 'socks5://all:3'
    })
  })

  it('ignores empty values', () => {
    expect(captureInheritedProxy({ http_proxy: '   ', HTTPS_PROXY: '' })).toEqual({
      http: '',
      https: '',
      noProxy: '',
      all: ''
    })
  })
})

describe('effective proxy selection', () => {
  const inherited = { http: '', https: '', noProxy: '', all: '' }

  it('uses the manual URLs and always leaves loopback direct', () => {
    expect(effectiveProxyUrls(manual, inherited, { http: '', https: '' })).toEqual({
      http: 'http://127.0.0.1:7890',
      https: 'http://127.0.0.1:7890',
      noProxy: 'corp.example,localhost,127.0.0.1,::1',
      source: 'manual'
    })
  })

  it('fills missing system values from resolved proxies', () => {
    expect(
      effectiveProxyUrls({ ...manual, mode: 'system' }, inherited, {
        http: 'http://resolved:8080',
        https: 'socks5h://resolved:1080'
      })
    ).toEqual({
      http: 'http://resolved:8080',
      https: 'socks5h://resolved:1080',
      noProxy: 'localhost,127.0.0.1,::1',
      source: 'system'
    })
  })

  it('lets inherited values win over resolved values', () => {
    expect(
      effectiveProxyUrls(
        { ...manual, mode: 'system' },
        { http: 'http://env:1', https: '', noProxy: 'corp.example', all: '' },
        { http: 'http://resolved:2', https: 'http://resolved:3' }
      )
    ).toEqual({
      http: 'http://env:1',
      https: 'http://resolved:3',
      noProxy: 'corp.example,localhost,127.0.0.1,::1',
      source: 'environment'
    })
  })

  it('uses ALL_PROXY only as a fallback and does not emit it', () => {
    const urls = effectiveProxyUrls(
      { ...manual, mode: 'system' },
      { http: '', https: '', noProxy: '', all: 'socks5://all:9' },
      { http: '', https: '' }
    )
    expect(urls).toMatchObject({
      http: 'socks5://all:9',
      https: 'socks5://all:9',
      source: 'environment'
    })
    const env = emittedProxyEnv(urls, 'linux')
    expect(env.HTTP_PROXY).toBe('socks5://all:9')
    expect(env.ALL_PROXY).toBeUndefined()
    expect(env.all_proxy).toBeUndefined()
  })

  it('emits nothing when mode is off', () => {
    const urls = effectiveProxyUrls({ ...manual, mode: 'off' }, inherited, {
      http: 'http://resolved:8080',
      https: 'http://resolved:8080'
    })
    expect(urls).toEqual({ http: '', https: '', noProxy: '', source: 'none' })
    expect(emittedProxyEnv(urls, 'linux')).toEqual({})
  })
})

describe('environment emission', () => {
  const urls = {
    http: 'http://127.0.0.1:7890',
    https: 'http://127.0.0.1:7890',
    noProxy: 'localhost,127.0.0.1,::1',
    source: 'manual' as const
  }

  it('uses lowercase only on Windows', () => {
    expect(emittedProxyEnv(urls, 'win32')).toEqual({
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      no_proxy: 'localhost,127.0.0.1,::1'
    })
  })

  it('emits both spellings on POSIX and in the guest', () => {
    expect(emittedProxyEnv(urls, 'linux')).toEqual({
      http_proxy: 'http://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      no_proxy: 'localhost,127.0.0.1,::1',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    })
    expect(emittedProxyEnv(urls, 'guest')).toEqual(emittedProxyEnv(urls, 'linux'))
  })
})

describe('resolveProxy parsing', () => {
  it('maps PROXY, HTTPS, and SOCKS5 entries', () => {
    expect(parseResolveProxyResult('PROXY 127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(parseResolveProxyResult('HTTPS proxy.example:443')).toBe('https://proxy.example:443')
    expect(parseResolveProxyResult('SOCKS5 127.0.0.1:1080')).toBe('socks5h://127.0.0.1:1080')
    expect(parseResolveProxyResult('SOCKS 127.0.0.1:1080')).toBe('socks5h://127.0.0.1:1080')
  })

  it('skips DIRECT, SOCKS4, and malformed entries', () => {
    expect(parseResolveProxyResult('DIRECT')).toBe('')
    expect(parseResolveProxyResult('DIRECT; PROXY 127.0.0.1:7890')).toBe(
      'http://127.0.0.1:7890'
    )
    expect(parseResolveProxyResult('SOCKS4 127.0.0.1:1080')).toBe('')
    expect(parseResolveProxyResult('SOCKS5 127.0.0.1')).toBe('')
    expect(parseResolveProxyResult('')).toBe('')
  })
})

describe('Chromium configuration', () => {
  it('maps modes directly', () => {
    expect(chromiumProxyConfig({ ...manual, mode: 'system' })).toEqual({ mode: 'system' })
    expect(chromiumProxyConfig({ ...manual, mode: 'off' })).toEqual({ mode: 'direct' })
  })

  it('builds per-scheme fixed-server rules', () => {
    expect(
      chromiumProxyConfig({
        mode: 'manual',
        httpProxyUrl: 'http://127.0.0.1:7890',
        httpsProxyUrl: 'socks5h://127.0.0.1:1080',
        noProxy: 'corp.example'
      })
    ).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http=127.0.0.1:7890;https=socks5://127.0.0.1:1080',
      proxyBypassRules: 'corp.example,localhost,127.0.0.1,::1'
    })
  })

  it('keeps an HTTPS proxy scheme and omits a missing scheme', () => {
    expect(
      chromiumProxyConfig({
        mode: 'manual',
        httpProxyUrl: '',
        httpsProxyUrl: 'https://proxy.example:8443',
        noProxy: ''
      })
    ).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'https=https://proxy.example:8443',
      proxyBypassRules: 'localhost,127.0.0.1,::1'
    })
  })
})

describe('WSL loopback rewriting', () => {
  it('recognizes loopback hosts', () => {
    expect(isLoopbackProxyHost('localhost')).toBe(true)
    expect(isLoopbackProxyHost('127.0.0.1')).toBe(true)
    expect(isLoopbackProxyHost('[::1]')).toBe(true)
    expect(isLoopbackProxyHost('0.0.0.0')).toBe(true)
    expect(isLoopbackProxyHost('proxy.example')).toBe(false)
  })

  it('rewrites only the proxy host', () => {
    expect(rewriteLoopbackProxyUrl('http://127.0.0.1:7890', '172.22.48.1')).toBe(
      'http://172.22.48.1:7890'
    )
    expect(rewriteLoopbackProxyUrl('socks5h://[::1]:1080', '172.22.48.1')).toBe(
      'socks5h://172.22.48.1:1080'
    )
    expect(rewriteLoopbackProxyUrl('http://proxy.example:7890', '172.22.48.1')).toBe(
      'http://proxy.example:7890'
    )
  })

  it('uses both cases and leaves NO_PROXY destinations alone', () => {
    const env = guestProxyEnv(manual, { http: '', https: '', noProxy: '', all: '' }, {
      http: '',
      https: ''
    }, { gateway: '172.22.48.1', mirrored: false })
    expect(env.HTTP_PROXY).toBe('http://172.22.48.1:7890')
    expect(env.http_proxy).toBe('http://172.22.48.1:7890')
    expect(env.NO_PROXY).toBe('corp.example,localhost,127.0.0.1,::1')
  })

  it('does not rewrite in mirrored mode', () => {
    const env = guestProxyEnv(manual, { http: '', https: '', noProxy: '', all: '' }, {
      http: '',
      https: ''
    }, { gateway: '172.22.48.1', mirrored: true })
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('returns sorted assignments for guest argv', () => {
    expect(guestEnvAssignments({ https_proxy: 'b', HTTP_PROXY: 'a' })).toEqual([
      'HTTP_PROXY=a',
      'https_proxy=b'
    ])
  })
})
