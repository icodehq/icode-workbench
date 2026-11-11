import { describe, expect, it } from 'vitest'
import {
  containsRedactionPlaceholder,
  isCloneableRemoteInput,
  parseRemoteUrl,
  redactRemoteUrlCredentials
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
})

describe('containsRedactionPlaceholder', () => {
  it('detects display placeholders so they are never submitted', () => {
    expect(containsRedactionPlaceholder('https://***@github.com/o/r')).toBe(true)
    expect(containsRedactionPlaceholder('https://%2A%2A%2A@github.com/o/r')).toBe(true)
    expect(containsRedactionPlaceholder('https://github.com/o/r')).toBe(false)
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
