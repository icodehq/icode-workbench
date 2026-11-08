import { describe, expect, it } from 'vitest'
import { toGuestVisiblePath } from './guest-visible-path'

/**
 * A guest Claude is handed the hook settings path. The file lives beside the
 * Windows user data, so the value must be respelled for the distro — otherwise
 * Claude receives a string Linux treats as a relative file name with backslashes.
 */
describe('guest-visible paths', () => {
  it('maps a drive path onto /mnt', () => {
    expect(toGuestVisiblePath('D:\\Development\\WSLProjects\\w71-profile\\agent-hooks\\settings.json')).toBe(
      '/mnt/d/Development/WSLProjects/w71-profile/agent-hooks/settings.json'
    )
    expect(toGuestVisiblePath('c:/Users/You/AppData/Roaming/iCode/agent-hooks/settings.json')).toBe(
      '/mnt/c/Users/You/AppData/Roaming/iCode/agent-hooks/settings.json'
    )
  })

  it('keeps spaces literal, because the value is passed as one argv element', () => {
    expect(toGuestVisiblePath('C:\\Users\\Example User\\AppData\\settings.json')).toBe(
      '/mnt/c/Users/Example User/AppData/settings.json'
    )
  })

  it('leaves anything that is not a drive path alone', () => {
    // No invented mapping: a POSIX path, a UNC path and a bare name stay as given.
    expect(toGuestVisiblePath('/home/u/settings.json')).toBe('/home/u/settings.json')
    expect(toGuestVisiblePath('\\\\server\\share\\s.json')).toBe('\\\\server\\share\\s.json')
    expect(toGuestVisiblePath('settings.json')).toBe('settings.json')
  })
})
