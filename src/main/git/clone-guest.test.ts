import { describe, expect, it } from 'vitest'
import type { WslCommandRunner } from '../wsl/exec'
import { resetGuestGitEnvironments } from '../wsl/git/guest-git'
import { runStreamingGuestClone } from './clone-guest'

function probeFixture(socket: string): Buffer {
  return Buffer.from(
    `__ICODE_GIT_OUT_START__/usr/local/bin:/usr/bin\0/usr/bin/git\0/home/u\0${socket}__ICODE_GIT_OUT_END__`
  )
}

function runnerWith(options: {
  probe: { code: number; stdout?: Buffer }
  onStream: (argv: readonly string[]) => void
}): WslCommandRunner {
  return {
    runBytes: async () => ({
      code: options.probe.code,
      signal: null,
      stdout: options.probe.stdout ?? Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false
    }),
    runStream: async (request: { argv: readonly string[] }) => {
      options.onStream(request.argv)
      return { code: 0, signal: null, timedOut: false, cancelled: false }
    }
  } as unknown as WslCommandRunner
}

describe('runStreamingGuestClone', () => {
  it('adds auth git options and the login agent socket to the direct route', async () => {
    resetGuestGitEnvironments()
    let argv: readonly string[] = []
    const runner = runnerWith({
      probe: { code: 0, stdout: probeFixture('/run/user/1000/openssh_agent') },
      onStream: (seen) => {
        argv = seen
      }
    })
    await runStreamingGuestClone({
      runner,
      distro: 'Ubuntu',
      url: 'https://gitee.com/o/r.git',
      destination: '/home/u/r',
      timeoutMs: 1_000,
      gitOptions: ['-c', 'credential.helper=!sh /home/u/helper.sh'],
      env: { GIT_ASKPASS: '' }
    })
    expect(argv).toContain('SSH_AUTH_SOCK=/run/user/1000/openssh_agent')
    expect(argv).toContain('GIT_TERMINAL_PROMPT=0')
    expect(argv).toContain('GIT_ASKPASS=')
    const gitIndex = argv.indexOf('/usr/bin/git')
    expect(gitIndex).toBeGreaterThan(0)
    expect(argv.slice(gitIndex + 1, gitIndex + 3)).toEqual([
      '-c',
      'credential.helper=!sh /home/u/helper.sh'
    ])
    expect(argv.slice(-2)).toEqual(['https://gitee.com/o/r.git', '/home/u/r'])
  })

  it('keeps the login-shell fallback non-interactive and passes the same options', async () => {
    resetGuestGitEnvironments()
    let argv: readonly string[] = []
    const runner = runnerWith({
      probe: { code: 78 },
      onStream: (seen) => {
        argv = seen
      }
    })
    await runStreamingGuestClone({
      runner,
      distro: 'Ubuntu',
      url: 'https://gitee.com/o/r.git',
      destination: '/home/u/r',
      timeoutMs: 1_000,
      gitOptions: ['-c', 'credential.helper=!sh /home/u/helper.sh'],
      env: { GIT_ASKPASS: '' }
    })
    expect(argv[0]).toBe('sh')
    expect(argv[1]).toBe('-lc')
    const command = argv[2] ?? ''
    expect(command).toContain('GIT_TERMINAL_PROMPT=0')
    expect(command).toContain('GIT_ASKPASS=')
    expect(command).toContain('credential.helper=!sh /home/u/helper.sh')
    expect(command).toContain('clone')
  })
})
