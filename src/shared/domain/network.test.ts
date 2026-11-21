import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  inspectNoProxy,
  inspectProxyUrl,
  noProxyWithLoopback,
  normalizeNoProxy,
  normalizeProxyUrl,
  parseNetworkProxySettings,
  validateNetworkProxySettings
} from './network'

describe('proxy URL inspection', () => {
  it('accepts the supported proxy schemes with an explicit port', () => {
    expect(inspectProxyUrl('http://127.0.0.1:7890')).toBeNull()
    expect(inspectProxyUrl('https://proxy.example:443')).toBeNull()
    expect(inspectProxyUrl('socks5://127.0.0.1:1080')).toBeNull()
    expect(inspectProxyUrl('socks5h://localhost:1080')).toBeNull()
  })

  it('requires a port and rejects credentials', () => {
    expect(inspectProxyUrl('http://127.0.0.1')).toBe('port')
    expect(inspectProxyUrl('http://user:pass@127.0.0.1:7890')).toBe('userinfo')
    expect(inspectProxyUrl('http://127.0.0.1:7890/extra')).toBe('path')
    expect(inspectProxyUrl('http://127.0.0.1:7890?x=1')).toBe('path')
    expect(inspectProxyUrl('ftp://127.0.0.1:21')).toBe('scheme')
    expect(inspectProxyUrl('http://127.0.0.1:7890 ')).toBe('control')
    expect(inspectProxyUrl('not a url')).toBe('control')
  })

  it('normalizes scheme and host and removes the trailing slash', () => {
    expect(normalizeProxyUrl('HTTP://Proxy.Example:8080/')).toBe('http://proxy.example:8080')
    expect(normalizeProxyUrl('socks5h://LOCALHOST:1080')).toBe('socks5h://localhost:1080')
    expect(normalizeProxyUrl('http://[::1]:7890')).toBe('http://[::1]:7890')
  })
})

describe('NO_PROXY inspection', () => {
  it('accepts hosts, suffixes, wildcards, addresses, and CIDR blocks', () => {
    expect(inspectNoProxy('localhost, .corp.example, *.internal, 10.0.0.0/8, ::1')).toBeNull()
    expect(inspectNoProxy('*')).toBeNull()
    expect(inspectNoProxy('<local>')).toBeNull()
  })

  it('rejects credentials, URLs, and control characters', () => {
    expect(inspectNoProxy('user@host')).toBe('token')
    expect(inspectNoProxy('http://host')).toBe('token')
    expect(inspectNoProxy('host\u0000')).toBe('token')
  })

  it('deduplicates and always leaves loopback direct', () => {
    expect(normalizeNoProxy('corp.example,corp.example, .local')).toBe('corp.example,.local')
    expect(noProxyWithLoopback('corp.example')).toBe('corp.example,localhost,127.0.0.1,::1')
    expect(noProxyWithLoopback('localhost, 127.0.0.1')).toBe('localhost,127.0.0.1,::1')
  })
})

describe('proxy settings validation and persisted parsing', () => {
  it('requires at least one URL in manual mode', () => {
    expect(
      validateNetworkProxySettings({
        mode: 'manual',
        httpProxyUrl: '',
        httpsProxyUrl: '',
        noProxy: ''
      })
    ).toEqual([{ field: 'mode', reason: 'manualNeedsProxy' }])
  })

  it('reports the offending URL field', () => {
    expect(
      validateNetworkProxySettings({
        mode: 'manual',
        httpProxyUrl: 'http://host',
        httpsProxyUrl: 'http://127.0.0.1:7890',
        noProxy: ''
      })
    ).toEqual([{ field: 'httpProxyUrl', reason: 'port' }])
  })

  it('defaults a missing or malformed record to system mode', () => {
    expect(parseNetworkProxySettings(null)).toEqual(DEFAULT_NETWORK_PROXY_SETTINGS)
    expect(parseNetworkProxySettings({ mode: 'sometimes' })).toEqual(
      DEFAULT_NETWORK_PROXY_SETTINGS
    )
  })

  it('normalizes a valid manual record', () => {
    expect(
      parseNetworkProxySettings({
        mode: 'manual',
        httpProxyUrl: 'HTTP://127.0.0.1:7890/',
        httpsProxyUrl: 'socks5h://LOCALHOST:1080',
        noProxy: 'corp.example, corp.example, .local'
      })
    ).toEqual({
      mode: 'manual',
      httpProxyUrl: 'http://127.0.0.1:7890',
      httpsProxyUrl: 'socks5h://localhost:1080',
      noProxy: 'corp.example,.local'
    })
  })

  it('falls back to system when a persisted manual record is invalid', () => {
    expect(
      parseNetworkProxySettings({
        mode: 'manual',
        httpProxyUrl: 'http://host',
        httpsProxyUrl: '',
        noProxy: ''
      })
    ).toEqual(DEFAULT_NETWORK_PROXY_SETTINGS)
  })

  it('keeps unused URL fields when the mode is not manual', () => {
    expect(
      parseNetworkProxySettings({
        mode: 'off',
        httpProxyUrl: ' http://127.0.0.1:7890 ',
        httpsProxyUrl: '',
        noProxy: 'corp.example'
      })
    ).toEqual({
      mode: 'off',
      httpProxyUrl: 'http://127.0.0.1:7890',
      httpsProxyUrl: '',
      noProxy: 'corp.example'
    })
  })
})
