import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  isNewerVersion,
  latestMetadataUrl,
  macDmgUrl,
  parseVersion,
  releasePageUrl,
  resolveUpdateMode,
  updateMetadataFileName
} from './update'

describe('update mode', () => {
  it('installs on Windows and packaged AppImages', () => {
    expect(resolveUpdateMode({ packaged: true, platform: 'win32', appImage: null })).toEqual({
      mode: 'install',
      unsupportedReason: null
    })
    expect(
      resolveUpdateMode({ packaged: true, platform: 'linux', appImage: '/opt/iCode.AppImage' })
    ).toEqual({ mode: 'install', unsupportedReason: null })
  })

  it('notifies on macOS and package-managed Linux', () => {
    expect(resolveUpdateMode({ packaged: true, platform: 'darwin', appImage: null })).toEqual({
      mode: 'notify',
      unsupportedReason: null
    })
    expect(resolveUpdateMode({ packaged: true, platform: 'linux', appImage: null })).toEqual({
      mode: 'notify',
      unsupportedReason: null
    })
  })

  it('is unsupported in development and unknown platforms', () => {
    expect(resolveUpdateMode({ packaged: false, platform: 'win32', appImage: null })).toEqual({
      mode: 'unsupported',
      unsupportedReason: 'not-packaged'
    })
    expect(resolveUpdateMode({ packaged: true, platform: 'freebsd', appImage: null })).toEqual({
      mode: 'unsupported',
      unsupportedReason: 'unsupported-platform'
    })
  })
})

describe('version comparison', () => {
  it('parses stable and prerelease versions', () => {
    expect(parseVersion('0.17.0')).toEqual({ major: 0, minor: 17, patch: 0, prerelease: [] })
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion('1.2.3-beta.2')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['beta', '2']
    })
    expect(parseVersion('not-a-version')).toBeNull()
    expect(parseVersion('1.2')).toBeNull()
  })

  it('orders numeric components, not strings', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
  })

  it('orders prereleases below stable and by identifier precedence', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1)
  })

  it('reports whether a candidate is newer', () => {
    expect(isNewerVersion('0.18.0', '0.17.9')).toBe(true)
    expect(isNewerVersion('0.17.0', '0.17.0')).toBe(false)
    expect(isNewerVersion('broken', '0.17.0')).toBe(false)
  })
})

describe('release URLs', () => {
  it('names the platform metadata file', () => {
    expect(updateMetadataFileName('win32')).toBe('latest.yml')
    expect(updateMetadataFileName('linux')).toBe('latest-linux.yml')
    expect(updateMetadataFileName('darwin')).toBe('latest-mac.yml')
    expect(updateMetadataFileName('freebsd')).toBeNull()
  })

  it('builds the latest-asset and release URLs', () => {
    expect(latestMetadataUrl('darwin')).toBe(
      'https://github.com/icodehq/icode-workbench/releases/latest/download/latest-mac.yml'
    )
    expect(releasePageUrl('0.18.0')).toBe(
      'https://github.com/icodehq/icode-workbench/releases/tag/v0.18.0'
    )
    expect(macDmgUrl('0.18.0', 'arm64')).toBe(
      'https://github.com/icodehq/icode-workbench/releases/download/v0.18.0/iCode-0.18.0-mac-arm64.dmg'
    )
  })
})
