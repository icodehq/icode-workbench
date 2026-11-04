import { describe, expect, it } from 'vitest'
import { guestLaunchSpec } from '../wsl/harness/guest-harness'
import { quoteForPosixShell, withLaunchArgs } from './launch-command'

/**
 * Work 70 measured the defect: a guest Claude was launched through a login shell
 * whose script `exec`s the harness, and iCode appended `--settings <path>` to argv —
 * which the shell consumed as `$0`/`$1`. `bash -ilc 'echo argc=$#' --settings x`
 * prints `argc=1`. These tests pin the corrected assembly.
 */
describe('launch arguments', () => {
  const SETTINGS = '/mnt/d/Development/WSLProjects/w71-profile/agent-hooks/settings.json'

  it('quotes a value so no shell syntax survives', () => {
    expect(quoteForPosixShell('/plain/path')).toBe("'/plain/path'")
    // A quote inside the value is closed, escaped and reopened.
    expect(quoteForPosixShell("a'b")).toBe("'a'\\''b'")
    expect(quoteForPosixShell('a b; rm -rf /')).toBe("'a b; rm -rf /'")
    expect(quoteForPosixShell('$(id)')).toBe("'$(id)'")
  })

  it('puts guest arguments inside the exec script, never in argv', () => {
    const command = guestLaunchSpec({ shell: '/bin/bash', mode: '-ilc' }, '/home/u/.nvm/bin/claude')
    const result = withLaunchArgs(command, ['--settings', SETTINGS])

    // argv stays exactly the shell invocation: two elements.
    expect(result.args).toHaveLength(2)
    expect(result.args[0]).toBe('-ilc')
    // The harness receives them because `exec` is followed by the quoted values.
    expect(result.args[1]).toBe(
      "exec '/home/u/.nvm/bin/claude' '--settings' '/mnt/d/Development/WSLProjects/w71-profile/agent-hooks/settings.json'"
    )
    // Nothing that the shell would read as $0/$1 is left behind.
    expect(result.args.slice(2)).toEqual([])
  })

  it('keeps a shell-special settings path inert', () => {
    const command = guestLaunchSpec({ shell: '/bin/sh', mode: '-lc' }, '/opt/claude')
    const nasty = '/home/u/a b/$(touch /tmp/pwned)/settings.json'
    const result = withLaunchArgs(command, ['--settings', nasty])
    expect(result.args[1]).toBe(`exec '/opt/claude' '--settings' '${nasty}'`)
    // The value is single-quoted, so the substitution cannot run.
    expect(result.args[1]).not.toContain("'$(touch")
  })

  it('leaves a plain command appending to argv (the local target)', () => {
    const command = { command: '/usr/local/bin/claude', args: [] as string[] }
    const result = withLaunchArgs(command, ['--settings', '/home/u/.config/iCode/agent-hooks/settings.json'])
    expect(result.command).toBe('/usr/local/bin/claude')
    expect(result.args).toEqual(['--settings', '/home/u/.config/iCode/agent-hooks/settings.json'])
    // No wrapper marker is invented for a plain executable.
    expect('shellWrapper' in result).toBe(false)
  })

  it('is a no-op when a harness has no extra arguments', () => {
    const command = guestLaunchSpec({ shell: '/bin/bash', mode: '-ilc' }, '/opt/claude')
    expect(withLaunchArgs(command, [])).toBe(command)
  })

  it('refuses a wrapper that names a missing script argument', () => {
    expect(() =>
      withLaunchArgs(
        { command: '/bin/bash', args: ['-ilc'], shellWrapper: { scriptIndex: 3 } },
        ['--settings', '/x']
      )
    ).toThrow(/shell wrapper at index 3/)
  })

  it('declares the wrapper contract exactly once, in the guest launch spec', () => {
    const spec = guestLaunchSpec({ shell: '/bin/zsh', mode: '-ilc' }, '/opt/claude')
    expect(spec.command).toBe('/bin/zsh')
    expect(spec.shellWrapper).toEqual({ scriptIndex: 1 })
  })
})
