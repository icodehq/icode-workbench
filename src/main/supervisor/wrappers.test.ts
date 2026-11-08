import { describe, expect, it } from 'vitest'
import {
  buildGuestWrapper,
  buildInstructions,
  buildLocalWrapper,
  buildWindowsWrapper,
  writeSupervisorControlFiles
} from './wrappers'
import { makeTempRoot } from '../persistence/persistence-test-fixtures'

describe('supervisor wrappers', () => {
  it('runs the CLI through Electron as Node for a local POSIX session', () => {
    const wrapper = buildLocalWrapper({
      execPath: '/opt/iCode/iCode',
      cliPath: '/home/me/.config/iCode/supervisor/icode-supervisor.cjs',
      configPath: '/home/me/.config/iCode/supervisor/projects/repo_1/control.json'
    })
    expect(wrapper).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(wrapper).toContain("'/opt/iCode/iCode'")
    expect(wrapper).toContain("--config '/home/me/.config/iCode/supervisor/projects/repo_1/control.json'")
  })

  it('keeps the guest executable in guest spelling and the CLI/config in Windows spelling', () => {
    const wrapper = buildGuestWrapper({
      execPath: '/mnt/c/Program Files/iCode/iCode.exe',
      cliPath: 'C:\\Users\\me\\AppData\\Roaming\\iCode\\supervisor\\icode-supervisor.cjs',
      configPath: 'C:\\Users\\me\\AppData\\Roaming\\iCode\\supervisor\\projects\\repo_1\\control.json'
    })
    expect(wrapper).toContain("'/mnt/c/Program Files/iCode/iCode.exe'")
    expect(wrapper).toContain("'C:\\Users\\me\\AppData\\Roaming\\iCode\\supervisor\\icode-supervisor.cjs'")
    expect(wrapper).toContain("'C:\\Users\\me\\AppData\\Roaming\\iCode\\supervisor\\projects\\repo_1\\control.json'")
    expect(wrapper).toContain('WSLENV=ELECTRON_RUN_AS_NODE')
    expect(wrapper).not.toContain('WSLENV=ELECTRON_RUN_AS_NODE/p')
  })

  it('writes a Windows wrapper that forwards arguments', () => {
    const wrapper = buildWindowsWrapper({
      execPath: 'C:\\Program Files\\iCode\\iCode.exe',
      cliPath: 'C:\\Users\\me\\AppData\\Roaming\\iCode\\supervisor\\icode-supervisor.cjs',
      configPath: 'C:\\Users\\me\\AppData\\Roaming\\iCode\\supervisor\\projects\\repo_1\\control.json'
    })
    expect(wrapper).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(wrapper).toContain('%*')
  })

  it('refuses a WSL project when userData cannot be translated', () => {
    const root = makeTempRoot('icode-supervisor-')
    try {
      expect(() =>
        writeSupervisorControlFiles({
          userDataDir: root.dir,
          execPath: '/opt/iCode/iCode',
          repoId: 'repo_1',
          repoName: 'Project',
          sessionId: 'ses_00000000-0000-4000-8000-000000000001',
          endpoint: '\\\\.\\pipe\\icode-supervisor',
          token: 'token',
          target: { kind: 'wsl', distro: 'Ubuntu', distroId: null },
          platform: 'linux'
        })
      ).toThrow(/not visible from this WSL distribution/)
    } finally {
      root.cleanup()
    }
  })

  it('describes the human gates in the instructions', () => {
    const text = buildInstructions({
      repoName: 'demo',
      command: 'sh /tmp/run.sh',
      instructionsPath: '/tmp/INSTRUCTIONS.md'
    })
    expect(text).toContain('do not implement')
    expect(text).toContain('A proposal does not run')
    expect(text).toContain('A person still makes the real decision')
    expect(text).toContain('events wait')
  })
})
