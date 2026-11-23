import { describe, expect, it, vi } from 'vitest'
import { createReleaseFeed } from './release-feed'

function yamlResponse(version: string, status = 200): Response {
  return new Response(
    `version: ${version}\nfiles:\n  - url: iCode-${version}-mac-arm64.zip\n    sha512: abc\n    size: 1\npath: iCode-${version}-mac-arm64.zip\nsha512: abc\nreleaseDate: '2026-11-23T00:00:00.000Z'\n`,
    { status }
  )
}

function feedFor(
  platform: string,
  arch: string,
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  now = () => 1_000
) {
  return createReleaseFeed({ fetch, platform, arch, now })
}

describe('release feed', () => {
  it('reports a newer stable version for install mode without a browser URL', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => yamlResponse('0.18.0'))
    const feed = feedFor('win32', 'x64', fetch)
    await expect(feed.check('0.17.0', 'install')).resolves.toEqual({
      status: 'available',
      checkedAt: 1_000,
      version: '0.18.0',
      releaseUrl: 'https://github.com/icodehq/icode-workbench/releases/tag/v0.18.0',
      downloadUrl: null
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://github.com/icodehq/icode-workbench/releases/latest/download/latest.yml?noCache=1000',
      expect.objectContaining({
        headers: expect.objectContaining({ accept: expect.stringContaining('yaml') })
      })
    )
  })

  it('returns the arch-matched dmg for macOS notify mode', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => yamlResponse('0.18.0'))
    const feed = feedFor('darwin', 'arm64', fetch)
    const result = await feed.check('0.17.0', 'notify')
    expect(result).toMatchObject({
      status: 'available',
      downloadUrl:
        'https://github.com/icodehq/icode-workbench/releases/download/v0.18.0/iCode-0.18.0-mac-arm64.dmg'
    })
    expect(fetch.mock.calls[0]?.[0]).toContain('/latest-mac.yml')
  })

  it('returns the release page for package-managed Linux notify mode', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => yamlResponse('0.18.0'))
    const feed = feedFor('linux', 'x64', fetch)
    const result = await feed.check('0.17.0', 'notify')
    expect(result).toMatchObject({
      status: 'available',
      downloadUrl: 'https://github.com/icodehq/icode-workbench/releases/tag/v0.18.0'
    })
    expect(fetch.mock.calls[0]?.[0]).toContain('/latest-linux.yml')
  })

  it('reports up-to-date for the same or an older version', async () => {
    const feed = feedFor('linux', 'x64', async () => yamlResponse('0.17.0'))
    await expect(feed.check('0.17.0', 'install')).resolves.toEqual({
      status: 'up-to-date',
      checkedAt: 1_000
    })

    const older = feedFor('linux', 'x64', async () => yamlResponse('0.16.9'))
    await expect(older.check('0.17.0', 'install')).resolves.toEqual({
      status: 'up-to-date',
      checkedAt: 1_000
    })
  })

  it('turns a missing feed, HTTP failure, bad YAML and network errors into one code', async () => {
    const notFound = feedFor('win32', 'x64', async () => new Response('', { status: 404 }))
    await expect(notFound.check('0.17.0', 'install')).rejects.toMatchObject({
      code: 'UPDATE_CHECK_FAILED',
      messageKey: 'updates.error.checkFailed'
    })

    const badYaml = feedFor('win32', 'x64', async () => new Response('not: [yaml', { status: 200 }))
    await expect(badYaml.check('0.17.0', 'install')).rejects.toMatchObject({
      code: 'UPDATE_CHECK_FAILED'
    })

    const noVersion = feedFor(
      'win32',
      'x64',
      async () => new Response('files: []\n', { status: 200 })
    )
    await expect(noVersion.check('0.17.0', 'install')).rejects.toMatchObject({
      code: 'UPDATE_CHECK_FAILED'
    })

    const prerelease = feedFor('win32', 'x64', async () => yamlResponse('0.18.0-beta.1'))
    await expect(prerelease.check('0.17.0', 'install')).rejects.toMatchObject({
      code: 'UPDATE_CHECK_FAILED'
    })

    const network = feedFor('win32', 'x64', async () => {
      throw new Error('offline')
    })
    await expect(network.check('0.17.0', 'install')).rejects.toMatchObject({
      code: 'UPDATE_CHECK_FAILED',
      detail: 'offline'
    })
  })

  it('uses an explicit feed base for tests and mirrors', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => yamlResponse('0.18.0'))
    const feed = createReleaseFeed({
      fetch,
      platform: 'linux',
      arch: 'x64',
      feedBaseUrl: 'http://127.0.0.1:9000/updates/',
      now: () => 1_000
    })
    await feed.check('0.17.0', 'notify')
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:9000/updates/latest-linux.yml?noCache=1000'
    )
  })

  it('refuses a platform with no feed', async () => {
    const fetch = vi.fn(async () => yamlResponse('0.18.0'))
    const feed = feedFor('freebsd', 'x64', fetch)
    await expect(feed.check('0.17.0', 'notify')).rejects.toMatchObject({
      code: 'UPDATE_CHECK_FAILED'
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
