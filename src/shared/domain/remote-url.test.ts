import { describe, expect, it } from 'vitest'
import {
  containsRedactionPlaceholder,
  isCloneableRemoteInput,
  parseRemoteUrl,
  redactRemoteUrlCredentials,
  toHttpsRemoteUrl,
  toSshRemoteUrl
} from './remote-url'

describe('parseRemoteUrl', () => {
  it('recognizes GitHub HTTPS URLs', () => {
    const parsed = parseRemoteUrl('https://github.com/owner/repo.git')
    expect(parsed).toMatchObject({
      provider: 'github',
      host: 'github.com',
      path: 'owner/repo',
      webUrl: 'https://github.com/owner/repo',
      suggestedName: 'repo',
      hasCredentials: false,
      isLocalPath: false
    })
  })

  it('recognizes GitLab subgroups', () => {
    const parsed = parseRemoteUrl('https://gitlab.com/group/subgroup/repo.git')
    expect(parsed).toMatchObject({
      provider: 'gitlab',
      host: 'gitlab.com',
      path: 'group/subgroup/repo',
      webUrl: 'https://gitlab.com/group/subgroup/repo',
      suggestedName: 'repo'
    })
  })

  it('recognizes SSH URLs with a port', () => {
    const parsed = parseRemoteUrl('ssh://git@git.example.com:2222/team/repo.git')
    expect(parsed).toMatchObject({
      provider: 'generic',
      host: 'git.example.com',
      path: 'team/repo',
      suggestedName: 'repo',
      webUrl: null
    })
  })

  it('recognizes scp-like URLs', () => {
    const parsed = parseRemoteUrl('git@github.com:owner/repo.git')
    expect(parsed).toMatchObject({
      provider: 'github',
      host: 'github.com',
      path: 'owner/repo',
      webUrl: 'https://github.com/owner/repo',
      suggestedName: 'repo',
      hasCredentials: false
    })
  })

  it('detects embedded credentials and redacts the display value', () => {
    const parsed = parseRemoteUrl('https://user:token@github.com/owner/repo.git')
    expect(parsed?.hasCredentials).toBe(true)
    expect(parsed?.displayUrl).toBe('https://***@github.com/owner/repo.git')
    expect(parsed?.displayUrl).not.toContain('token')
    expect(parsed?.webUrl).toBe('https://github.com/owner/repo')
  })

  it('accepts username-only userinfo as credentials', () => {
    expect(parseRemoteUrl('https://user@example.com/team/repo')?.hasCredentials).toBe(true)
  })

  it('keeps generic HTTPS URLs openable without userinfo', () => {
    const parsed = parseRemoteUrl('https://example.com/team/repo.git')
    expect(parsed).toMatchObject({ provider: 'generic', host: 'example.com' })
    expect(parsed?.webUrl).toBe('https://example.com/team/repo')
  })

  it('treats file URLs as local sources', () => {
    const parsed = parseRemoteUrl('file:///home/u/repos/project.git')
    expect(parsed).toMatchObject({
      provider: 'generic',
      path: 'home/u/repos/project',
      suggestedName: 'project',
      isLocalPath: true,
      webUrl: null
    })
  })

  it('treats POSIX and Windows paths as local sources', () => {
    expect(parseRemoteUrl('/srv/git/project.git')).toMatchObject({
      path: '/srv/git/project.git',
      suggestedName: 'project',
      isLocalPath: true
    })
    expect(parseRemoteUrl('D:\\repos\\project')).toMatchObject({
      suggestedName: 'project',
      isLocalPath: true
    })
    expect(parseRemoteUrl('\\\\server\\share\\project')).toMatchObject({
      suggestedName: 'project',
      isLocalPath: true
    })
  })

  it('strips exactly one .git suffix', () => {
    expect(parseRemoteUrl('https://github.com/o/repo.git.git')?.suggestedName).toBe('repo.git')
  })

  it('does not mistake a Windows drive for scp-like syntax', () => {
    expect(parseRemoteUrl('C:\\src\\repo')?.provider).toBe('generic')
    expect(parseRemoteUrl('C:\\src\\repo')?.host).toBeNull()
    expect(parseRemoteUrl('C:\\src\\repo')?.isLocalPath).toBe(true)
  })

  it('does not strip .git from a group segment', () => {
    expect(parseRemoteUrl('https://github.com/tools.git/repo.git')?.path).toBe('tools.git/repo')
  })

  it('records the scheme and non-default port', () => {
    expect(parseRemoteUrl('https://example.com/team/repo.git')).toMatchObject({
      scheme: 'https',
      port: null
    })
    expect(parseRemoteUrl('ssh://git@git.example.com:2222/team/repo.git')).toMatchObject({
      scheme: 'ssh',
      port: 2222
    })
    expect(parseRemoteUrl('git@github.com:owner/repo.git')).toMatchObject({
      scheme: 'ssh',
      port: null
    })
    expect(parseRemoteUrl('/srv/git/repo.git')).toMatchObject({ scheme: null, port: null })
    expect(parseRemoteUrl('D:\\repos\\repo')).toMatchObject({ scheme: null, port: null })
  })

  it('rejects empty values, options and unknown helpers', () => {
    expect(parseRemoteUrl('')).toBeNull()
    expect(parseRemoteUrl('   ')).toBeNull()
    expect(parseRemoteUrl('-oProxyCommand=calc')).toBeNull()
    expect(parseRemoteUrl('ext::sh -c touch% /tmp/pwned')).toBeNull()
    expect(parseRemoteUrl('fd::17')).toBeNull()
    expect(parseRemoteUrl('https://example.com/a\u0000b')).toBeNull()
  })
})

describe('redactRemoteUrlCredentials', () => {
  it('redacts credentials inside arbitrary Git output', () => {
    const line =
      "fatal: could not read from https://alice:ghp_secret@github.com/o/r.git: denied"
    const redacted = redactRemoteUrlCredentials(line)
    expect(redacted).not.toContain('ghp_secret')
    expect(redacted).toContain('https://***@github.com/o/r.git')
  })

  it('leaves credential-free URLs untouched', () => {
    const line = 'Fetching https://github.com/o/r.git'
    expect(redactRemoteUrlCredentials(line)).toBe(line)
  })

  it('redacts a proxy URL that carries credentials', () => {
    const line = 'fatal: cannot connect through socks5://alice:secret@127.0.0.1:1080'
    const redacted = redactRemoteUrlCredentials(line)
    expect(redacted).not.toContain('secret')
    expect(redacted).toContain('socks5://***@127.0.0.1:1080')
  })
})

describe('containsRedactionPlaceholder', () => {
  it('detects display placeholders so they are never submitted', () => {
    expect(containsRedactionPlaceholder('https://***@github.com/o/r')).toBe(true)
    expect(containsRedactionPlaceholder('https://%2A%2A%2A@github.com/o/r')).toBe(true)
    expect(containsRedactionPlaceholder('https://github.com/o/r')).toBe(false)
  })
})

describe('toSshRemoteUrl', () => {
  it('converts HTTPS URLs, preferring the scp-like form for known hosts', () => {
    expect(toSshRemoteUrl('https://github.com/owner/repo.git')).toBe(
      'git@github.com:owner/repo.git'
    )
    expect(toSshRemoteUrl('https://gitee.com/owner/repo.git')).toBe('git@gitee.com:owner/repo.git')
    expect(toSshRemoteUrl('https://git.example.com/team/repo.git')).toBe(
      'ssh://git@git.example.com/team/repo.git'
    )
  })

  it('keeps SSH spellings and refuses local or credential-bearing values', () => {
    expect(toSshRemoteUrl('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git')
    expect(toSshRemoteUrl('ssh://git@host:2222/team/repo.git')).toBe(
      'ssh://git@host:2222/team/repo.git'
    )
    expect(toSshRemoteUrl('/srv/git/repo.git')).toBeNull()
    expect(toSshRemoteUrl('https://user:token@github.com/owner/repo.git')).toBeNull()
    expect(toSshRemoteUrl('https://example.com:8443/team/repo.git')).toBeNull()
  })
})

describe('toHttpsRemoteUrl', () => {
  it('converts SSH spellings and keeps HTTPS unchanged', () => {
    expect(toHttpsRemoteUrl('git@github.com:owner/repo.git')).toBe(
      'https://github.com/owner/repo.git'
    )
    expect(toHttpsRemoteUrl('ssh://git@git.example.com:2222/team/repo.git')).toBe(
      'https://git.example.com:2222/team/repo.git'
    )
    expect(toHttpsRemoteUrl('https://example.com/team/repo.git')).toBe(
      'https://example.com/team/repo.git'
    )
  })

  it('refuses local and credential-bearing values', () => {
    expect(toHttpsRemoteUrl('/srv/git/repo.git')).toBeNull()
    expect(toHttpsRemoteUrl('file:///srv/git/repo.git')).toBeNull()
    expect(toHttpsRemoteUrl('https://user:token@example.com/team/repo.git')).toBeNull()
  })
})

describe('isCloneableRemoteInput', () => {
  it('accepts the supported spellings', () => {
    expect(isCloneableRemoteInput('https://github.com/o/r.git')).toBe(true)
    expect(isCloneableRemoteInput('ssh://git@host:22/o/r.git')).toBe(true)
    expect(isCloneableRemoteInput('git@github.com:o/r.git')).toBe(true)
    expect(isCloneableRemoteInput('/srv/git/r.git')).toBe(true)
    expect(isCloneableRemoteInput('D:\\repos\\r')).toBe(true)
    expect(isCloneableRemoteInput('file:///srv/git/r.git')).toBe(true)
  })

  it('rejects helpers, unknown schemes and option-looking values', () => {
    expect(isCloneableRemoteInput('ext::sh -c whoami')).toBe(false)
    expect(isCloneableRemoteInput('fd::17')).toBe(false)
    expect(isCloneableRemoteInput('--upload-pack=calc')).toBe(false)
    expect(isCloneableRemoteInput('')).toBe(false)
    expect(isCloneableRemoteInput('https://***@github.com/o/r')).toBe(false)
    expect(isCloneableRemoteInput('https://')).toBe(false)
    expect(isCloneableRemoteInput('ssh:///no-host')).toBe(false)
  })
})
