import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ACTIVITY_EVENTS } from '../../shared/domain/activity'
import {
  GUEST_SETTINGS_NAME,
  buildClaudeSettings,
  buildGuestClaudeSettings,
  guestHookCommandFor,
  installClaudeHooks
} from './claude-hooks'

/**
 * A guest Claude runs in Linux while the hook process that owns the activity
 * socket is a Windows process. Work 72 measured that all four crossings work —
 * a Windows executable is startable by its `/mnt/<drive>/…` spelling, argv is
 * passed verbatim, `WSLENV` carries selected variables, and stdin survives — so
 * the guest overlay is built from exactly those facts.
 *
 * These tests pin the generated *commands*, because everything downstream
 * (process start, env, IPC) was only observed to work for this exact shape.
 */

const ACCESS = {
  guestExecutablePath: '/mnt/d/Apps/iCode/icode.exe',
  scriptPath: 'D:\\Users\\Example User\\AppData\\Roaming\\iCode\\agent-hooks\\icode-activity-hook.cjs',
  activitySocket: '\\\\.\\pipe\\icode-activity-1a2b3c'
}

const commands = (settings: string): string[] => {
  const parsed = JSON.parse(settings) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>
  }
  return ACTIVITY_EVENTS.map((event) => parsed.hooks[event]![0]!.hooks[0]!.command)
}

describe('guest Claude settings', () => {
  it('is valid JSON covering every activity event', () => {
    const settings = buildGuestClaudeSettings(ACCESS, true)
    const parsed = JSON.parse(settings) as { hooks: Record<string, unknown> }
    expect(Object.keys(parsed.hooks).sort()).toEqual([...ACTIVITY_EVENTS].sort())
  })

  it('starts the Windows hook through a guest-executable path, never a drive path', () => {
    for (const command of commands(buildGuestClaudeSettings(ACCESS, true))) {
      // The executable is the /mnt spelling: a guest shell cannot exec `D:\…`.
      expect(command).toContain("'/mnt/d/Apps/iCode/icode.exe'")
      expect(command).not.toContain("'D:\\Apps")
    }
  })

  it('passes the script in Windows spelling, because a Windows process reads it', () => {
    const command = commands(buildGuestClaudeSettings(ACCESS, true))[0]!
    expect(command).toContain(`'${ACCESS.scriptPath}'`)
  })

  it('carries the activity endpoint and crosses the per-session variables', () => {
    const command = commands(buildGuestClaudeSettings(ACCESS, true))[0]!
    expect(command).toContain(`ICODE_ACTIVITY_SOCKET='${ACCESS.activitySocket}'`)
    // Without /p: a pipe name is not a path and must arrive unchanged.
    expect(command).toContain(
      "WSLENV='ICODE_ACTIVITY_SOCKET:ICODE_SESSION_ID:ICODE_SESSION_INCARNATION:ELECTRON_RUN_AS_NODE'"
    )
    expect(command).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(command).not.toMatch(/WSLENV='[^']*\/p/)
  })

  it('keeps the event name as argv and carries no shell syntax from the paths', () => {
    for (const event of ACTIVITY_EVENTS) {
      const command = guestHookCommandFor(ACCESS, event, true)
      expect(command.endsWith(`'${event}'`)).toBe(true)
    }
    // A space in the script path stays inside one quoted word.
    expect(guestHookCommandFor(ACCESS, 'Stop', true)).toContain(
      "'D:\\Users\\Example User\\AppData\\Roaming\\iCode\\agent-hooks\\icode-activity-hook.cjs'"
    )
  })

  it('detaches turn-end hooks only when the executable is packaged Electron', () => {
    const stop = commands(buildGuestClaudeSettings(ACCESS, true))[
      ACTIVITY_EVENTS.indexOf('Stop')
    ]!
    expect(stop.startsWith("sh -c '")).toBe(true)
    // Dev (node) needs no detach and no ELECTRON_RUN_AS_NODE anywhere.
    const devSettings = buildGuestClaudeSettings(ACCESS, false)
    expect(commands(devSettings).join('\n')).not.toContain('ELECTRON_RUN_AS_NODE')
    expect(commands(devSettings)[ACTIVITY_EVENTS.indexOf('Stop')]!.startsWith('env ')).toBe(true)
  })

  it('still matches the local overlay event-for-event (no semantic drift)', () => {
    // Compare against the POSIX local overlay explicitly; on Windows the local
    // overlay uses a cmd.exe wrapper, which is a different command shape.
    const local = commands(buildClaudeSettings('/usr/bin/node', '/tmp/hook.cjs', false, 'linux'))
    const guest = commands(buildGuestClaudeSettings(ACCESS, false))
    expect(guest).toHaveLength(local.length)
    // The event name is the last word of both, so neither invents a new event.
    for (let i = 0; i < local.length; i += 1) {
      expect(local[i]!.endsWith(`'${ACTIVITY_EVENTS[i]!}'`)).toBe(true)
      expect(guest[i]!.endsWith(`'${ACTIVITY_EVENTS[i]!}'`)).toBe(true)
    }
  })
})

describe('installing the guest overlay', () => {
  let root: string | null = null
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
  })

  it('writes both overlays and leaves the local one byte-identical', () => {
    root = mkdtempSync(join(tmpdir(), 'icode-hooks-'))
    const directory = join(root, 'agent-hooks')

    const withoutGuest = installClaudeHooks({
      directory,
      execPath: '/usr/bin/node',
      electronRunAsNode: false
    })
    const localBefore = readFileSync(withoutGuest.settingsPath, 'utf8')
    expect(withoutGuest.guestSettingsPath).toBeNull()
    expect(withoutGuest.guestLaunchArgs).toEqual([])

    const withGuest = installClaudeHooks({
      directory,
      execPath: '/usr/bin/node',
      electronRunAsNode: false,
      guest: { guestExecutablePath: '/mnt/c/node.exe', activitySocket: '\\\\.\\pipe\\icode-activity-x' }
    })
    // Local behaviour is untouched by the guest overlay existing.
    expect(readFileSync(withGuest.settingsPath, 'utf8')).toBe(localBefore)
    expect(withGuest.launchArgs).toEqual(withoutGuest.launchArgs)
    expect(withGuest.guestSettingsPath).toBe(join(directory, GUEST_SETTINGS_NAME))
    const guest = JSON.parse(readFileSync(withGuest.guestSettingsPath!, 'utf8')) as {
      hooks: Record<string, unknown>
    }
    expect(Object.keys(guest.hooks)).toHaveLength(ACTIVITY_EVENTS.length)
  })
})
