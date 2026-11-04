import { describe, expect, it } from 'vitest'
import {
  WINDOWS_PIPE_PREFIX,
  isNamedPipe,
  namedPipe
} from './endpoint'

describe('named pipe endpoints', () => {
  it('recognises the Windows pipe namespace', () => {
    expect(isNamedPipe('\\\\.\\pipe\\icode-host-abc123')).toBe(true)
    expect(isNamedPipe('\\\\?\\pipe\\icode-host-abc123')).toBe(true)
    // Forward slashes appear when a path is normalised by a caller.
    expect(isNamedPipe('//./pipe/icode-host-abc123')).toBe(true)
  })

  it('does not mistake a filesystem path for a pipe', () => {
    expect(isNamedPipe('/run/user/1000/icode/abc/terminal-host.sock')).toBe(false)
    expect(isNamedPipe('C:\\Users\\a\\AppData\\Roaming\\icode\\terminal-host.sock')).toBe(
      false
    )
    expect(isNamedPipe('/tmp/icode/terminal-host.sock')).toBe(false)
    // A colon is normal in a Windows path and must not imply a pipe.
    expect(isNamedPipe('C:/temp/pipe/terminal-host.sock')).toBe(false)
  })

  it('builds a deterministic, scoped pipe name', () => {
    expect(namedPipe('icode-host', 'abc123')).toBe(`${WINDOWS_PIPE_PREFIX}icode-host-abc123`)
    expect(namedPipe('icode-host', 'abc123')).toBe(namedPipe('icode-host', 'abc123'))
    expect(namedPipe('icode-host', 'abc123')).not.toBe(namedPipe('icode-host', 'def456'))
  })
})
