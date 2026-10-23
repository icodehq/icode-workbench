import { describe, expect, it } from 'vitest'
import {
  WINDOWS_PIPE_PREFIX,
  isNamedPipe,
  namedPipe
} from './endpoint'

describe('named pipe endpoints', () => {
  it('recognises the Windows pipe namespace', () => {
    expect(isNamedPipe('\\\\.\\pipe\\ade-host-abc123')).toBe(true)
    expect(isNamedPipe('\\\\?\\pipe\\ade-host-abc123')).toBe(true)
    // Forward slashes appear when a path is normalised by a caller.
    expect(isNamedPipe('//./pipe/ade-host-abc123')).toBe(true)
  })

  it('does not mistake a filesystem path for a pipe', () => {
    expect(isNamedPipe('/run/user/1000/ade/abc/terminal-host.sock')).toBe(false)
    expect(isNamedPipe('C:\\Users\\a\\AppData\\Roaming\\ade\\terminal-host.sock')).toBe(
      false
    )
    expect(isNamedPipe('/tmp/ade/terminal-host.sock')).toBe(false)
    // A colon is normal in a Windows path and must not imply a pipe.
    expect(isNamedPipe('C:/temp/pipe/terminal-host.sock')).toBe(false)
  })

  it('builds a deterministic, scoped pipe name', () => {
    expect(namedPipe('ade-host', 'abc123')).toBe(`${WINDOWS_PIPE_PREFIX}ade-host-abc123`)
    expect(namedPipe('ade-host', 'abc123')).toBe(namedPipe('ade-host', 'abc123'))
    expect(namedPipe('ade-host', 'abc123')).not.toBe(namedPipe('ade-host', 'def456'))
  })
})
