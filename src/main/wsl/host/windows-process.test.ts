import { describe, expect, it } from 'vitest'
import {
  asWindowsProcessId,
  buildCimQueryScript,
  classifyHolderEvidence,
  isHolderCommandLine,
  parseCimProcessOutput,
  WSL_HOLDER_MARKER
} from './windows-process'

const HOLDER_CMD = `wsl.exe -d Ubuntu-26.04 --exec /bin/sh -c while :; do sleep 3600; done ${WSL_HOLDER_MARKER}`
const RECORD = { creationTimeMs: 1_729_000_000_000 }

describe('CIM evidence parsing', () => {
  it('parses the tab-separated row a real CIM query returns', () => {
    // Captured from Win32_Process on this machine (read-only query).
    const evidence = parseCimProcessOutput('2304\t134366340217240050\tC:\\WINDOWS\\Explorer.EXE\r\n')
    expect(evidence.status).toBe('present')
    if (evidence.status === 'present') {
      expect(evidence.commandLine).toBe('C:\\WINDOWS\\Explorer.EXE')
      // 134366340217240050 ticks is 2026-10-23; a wrong epoch would land in 1601.
      expect(new Date(evidence.creationTimeMs!).getUTCFullYear()).toBe(2026)
    }
  })

  it('keeps an empty command line as null, not as an empty match', () => {
    const evidence = parseCimProcessOutput('42\t134366340217240050\t\r\n')
    expect(evidence.status).toBe('present')
    if (evidence.status === 'present') expect(evidence.commandLine).toBeNull()
  })

  it('reports a missing process for empty output', () => {
    expect(parseCimProcessOutput('')).toEqual({ status: 'missing' })
    expect(parseCimProcessOutput('\r\n')).toEqual({ status: 'missing' })
  })

  it('reports unavailable for a row it cannot parse', () => {
    expect(parseCimProcessOutput('garbage')).toEqual({ status: 'unavailable' })
    expect(parseCimProcessOutput('42\tnot-ticks\tcmd')).toEqual({ status: 'unavailable' })
  })

  it('builds a filter from digits only', () => {
    const pid = asWindowsProcessId(4242)!
    const script = buildCimQueryScript(pid)
    expect(script).toContain('ProcessId=4242')
    expect(script).not.toContain('; rm')
  })

  it('refuses a pid that is not a positive safe integer', () => {
    expect(asWindowsProcessId(0)).toBeNull()
    expect(asWindowsProcessId(-1)).toBeNull()
    expect(asWindowsProcessId(1.5)).toBeNull()
  })
})

describe('holder command-line identity', () => {
  it('accepts our holder for the same distro', () => {
    expect(isHolderCommandLine(HOLDER_CMD, 'Ubuntu-26.04')).toBe(true)
  })

  it('is case-insensitive, as distro names are', () => {
    expect(isHolderCommandLine(HOLDER_CMD, 'ubuntu-26.04')).toBe(true)
  })

  it('rejects a holder for a different distro', () => {
    expect(isHolderCommandLine(HOLDER_CMD, 'Ubuntu-24.04')).toBe(false)
  })

  it('rejects a wsl.exe that is not a holder', () => {
    expect(isHolderCommandLine('wsl.exe -d Ubuntu-26.04 --exec bash', 'Ubuntu-26.04')).toBe(false)
  })

  it('rejects an unrelated process that merely mentions the marker', () => {
    expect(isHolderCommandLine(`notepad.exe ${WSL_HOLDER_MARKER}`, 'Ubuntu-26.04')).toBe(false)
  })

  it('rejects a distro name that is only a prefix of the real one', () => {
    expect(isHolderCommandLine(HOLDER_CMD, 'Ubuntu')).toBe(false)
  })
})

describe('holder classification', () => {
  it('is live when pid, creation time and command line all agree', () => {
    expect(
      classifyHolderEvidence(
        RECORD,
        { status: 'present', creationTimeMs: RECORD.creationTimeMs, commandLine: HOLDER_CMD },
        'Ubuntu-26.04'
      )
    ).toEqual({ state: 'live', reason: 'verified' })
  })

  it('is exited when the creation time differs — PID reuse, not our holder', () => {
    const classification = classifyHolderEvidence(
      RECORD,
      { status: 'present', creationTimeMs: RECORD.creationTimeMs + 1, commandLine: HOLDER_CMD },
      'Ubuntu-26.04'
    )
    expect(classification.state).toBe('exited')
    expect(classification.reason).toBe('creation_time_mismatch')
  })

  it('is exited when the command line belongs to another process', () => {
    expect(
      classifyHolderEvidence(
        RECORD,
        { status: 'present', creationTimeMs: RECORD.creationTimeMs, commandLine: 'C:\\Windows\\notepad.exe' },
        'Ubuntu-26.04'
      ).state
    ).toBe('exited')
  })

  it('is unverifiable when the command line cannot be read', () => {
    // Something is running under that pid; calling it dead would license a duplicate.
    expect(
      classifyHolderEvidence(
        RECORD,
        { status: 'present', creationTimeMs: RECORD.creationTimeMs, commandLine: null },
        'Ubuntu-26.04'
      ).state
    ).toBe('unverifiable')
  })

  it('is unverifiable when the process table cannot be read', () => {
    expect(classifyHolderEvidence(RECORD, { status: 'unavailable' }, 'Ubuntu-26.04')).toEqual({
      state: 'unverifiable',
      reason: 'evidence_unavailable'
    })
  })

  it('is exited when the process is gone', () => {
    expect(classifyHolderEvidence(RECORD, { status: 'missing' }, 'Ubuntu-26.04')).toEqual({
      state: 'exited',
      reason: 'process_missing'
    })
  })

  it('is live from the command line alone when the record never had a time', () => {
    expect(
      classifyHolderEvidence(
        { creationTimeMs: null },
        { status: 'present', creationTimeMs: 123, commandLine: HOLDER_CMD },
        'Ubuntu-26.04'
      )
    ).toEqual({ state: 'live', reason: 'verified_without_creation_time' })
  })

  it('is unverifiable when the record has a time but the table does not', () => {
    expect(
      classifyHolderEvidence(
        RECORD,
        { status: 'present', creationTimeMs: null, commandLine: HOLDER_CMD },
        'Ubuntu-26.04'
      ).state
    ).toBe('unverifiable')
  })
})
