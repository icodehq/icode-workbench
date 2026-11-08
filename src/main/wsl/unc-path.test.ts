import { describe, expect, it } from 'vitest'
import { fromWslUncPath, parseWslUnc, toWslUncPath } from './unc-path'

/**
 * The one path transformation in the browsing flow.
 *
 * A Windows folder dialog can only browse a distro through
 * `\\wsl.localhost\<distro>`, so the chosen spelling has to be turned back into
 * the Linux path the repository is recorded with. The cases that matter are the
 * refusals: a Windows drive or another distro must not be silently adopted as
 * this target's path.
 */

describe('toWslUncPath', () => {
  it('maps a Linux home to the distro UNC namespace', () => {
    expect(toWslUncPath('/home/example', 'Ubuntu-26.04')).toBe(
      '\\\\wsl.localhost\\Ubuntu-26.04\\home\\example'
    )
  })

  it('maps the root to the distro root', () => {
    expect(toWslUncPath('/', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\')
  })

  it('collapses redundant separators without changing the path', () => {
    expect(toWslUncPath('//home//you//', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\you')
  })

  it('refuses anything that is not an absolute Linux path', () => {
    expect(toWslUncPath('home/you', 'Ubuntu')).toBeNull()
    expect(toWslUncPath('C:\\Users\\you', 'Ubuntu')).toBeNull()
    expect(toWslUncPath('', 'Ubuntu')).toBeNull()
  })

  it('refuses a traversal segment rather than resolving it', () => {
    // A pick comes from a dialog that already resolved its path, so `..` here
    // means the input did not come from where the caller believes it did.
    expect(toWslUncPath('/home/../etc', 'Ubuntu')).toBeNull()
  })

  it('refuses a missing distro name', () => {
    expect(toWslUncPath('/home/you', '  ')).toBeNull()
  })
})

describe('parseWslUnc', () => {
  it('recognises a distro spelling and its Linux path', () => {
    expect(parseWslUnc('\\\\wsl.localhost\\Ubuntu-26.04\\home\\you\\repo')).toEqual({
      distro: 'Ubuntu-26.04',
      path: '/home/you/repo'
    })
    expect(parseWslUnc('\\\\wsl$\\Debian\\srv')).toEqual({ distro: 'Debian', path: '/srv' })
  })

  it('does not treat a Windows or ordinary UNC path as a distro', () => {
    expect(parseWslUnc('D:\\Development\\repo')).toBeNull()
    expect(parseWslUnc('\\server\share\repo')).toBeNull()
    expect(parseWslUnc('relative')).toBeNull()
  })
})

describe('fromWslUncPath', () => {
  it('returns the Linux path of a pick inside that distro', () => {
    expect(fromWslUncPath('\\\\wsl.localhost\\Ubuntu-26.04\\home\\you\\repo', 'Ubuntu-26.04')).toEqual({
      kind: 'linux',
      path: '/home/you/repo'
    })
  })

  it('accepts the legacy wsl$ spelling and forward slashes', () => {
    expect(fromWslUncPath('\\\\wsl$\\Ubuntu\\srv\\app', 'Ubuntu')).toEqual({
      kind: 'linux',
      path: '/srv/app'
    })
    expect(fromWslUncPath('//wsl.localhost/Ubuntu/srv/app', 'Ubuntu')).toEqual({
      kind: 'linux',
      path: '/srv/app'
    })
  })

  it('matches the distro name case-insensitively', () => {
    expect(fromWslUncPath('\\\\wsl.localhost\\ubuntu\\srv', 'Ubuntu')).toEqual({
      kind: 'linux',
      path: '/srv'
    })
  })

  it('treats the distro root as the Linux root', () => {
    expect(fromWslUncPath('\\\\wsl.localhost\\Ubuntu', 'Ubuntu')).toEqual({ kind: 'linux', path: '/' })
  })

  it('refuses a Windows drive folder', () => {
    // The dialog can be navigated out of the distro; that folder is this machine's.
    expect(fromWslUncPath('D:\\Development\\repo', 'Ubuntu')).toEqual({ kind: 'windows-drive' })
    expect(fromWslUncPath('C:/Users/you', 'Ubuntu')).toEqual({ kind: 'windows-drive' })
  })

  it('names the other distro instead of accepting it', () => {
    expect(fromWslUncPath('\\\\wsl.localhost\\Debian\\home\\you', 'Ubuntu')).toEqual({
      kind: 'other-distro',
      distro: 'Debian'
    })
  })

  it('refuses a bare UNC share that is not a distro', () => {
    expect(fromWslUncPath('\\\\server\\share\\repo', 'Ubuntu')).toEqual({ kind: 'outside' })
    expect(fromWslUncPath('relative/path', 'Ubuntu')).toEqual({ kind: 'outside' })
    expect(fromWslUncPath('', 'Ubuntu')).toEqual({ kind: 'outside' })
  })
})
