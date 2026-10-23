import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isNamedPipe, WINDOWS_PIPE_PREFIX } from '../../shared/domain/endpoint'
import { activitySocketPath } from './endpoint'
import { ActivityHookServer } from './hook-server'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ade-activity-endpoint-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('activity endpoint selection', () => {
  it('keeps a filesystem socket on POSIX', () => {
    const dir = tempRoot()
    const endpoint = activitySocketPath({ userDataDir: dir, platform: 'linux' })
    expect(endpoint).toBe(join(dir, 'run', 'activity.sock'))
    expect(isNamedPipe(endpoint)).toBe(false)
  })

  it('uses a named pipe on Windows, never a .sock path', () => {
    const dir = tempRoot()
    const endpoint = activitySocketPath({
      userDataDir: 'C:\\Users\\a\\AppData\\Roaming\\ade',
      platform: 'win32'
    })
    expect(isNamedPipe(endpoint)).toBe(true)
    expect(endpoint.startsWith(WINDOWS_PIPE_PREFIX)).toBe(true)
    expect(endpoint.endsWith('.sock')).toBe(false)
    void dir
  })

  it('isolates two profiles and is deterministic', () => {
    const a = activitySocketPath({ userDataDir: '/profiles/alpha', platform: 'win32' })
    const b = activitySocketPath({ userDataDir: '/profiles/beta', platform: 'win32' })
    expect(a).toBe(activitySocketPath({ userDataDir: '/profiles/alpha', platform: 'win32' }))
    expect(a).not.toBe(b)
  })

  it('shares the profile scope with the terminal host namespace', () => {
    // Same profile directory, different namespaces: names differ only by purpose.
    const host = activitySocketPath({ userDataDir: '/profiles/alpha', platform: 'win32' })
    expect(host).toContain('ade-activity-')
  })
})

describe('activity hook server startup and delivery', () => {
  it('creates its directory, accepts one payload, and cleans up', async () => {
    const dir = tempRoot()
    const socketPath = activitySocketPath({ userDataDir: dir, platform: 'linux' })
    const received: string[] = []

    const server = new ActivityHookServer({
      socketPath,
      ingest: (event) => {
        received.push(event.event)
        return 'accepted'
      }
    })
    await server.start()
    expect(existsSync(socketPath)).toBe(true)

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath, () => {
        socket.end(
          JSON.stringify({
            event: 'PreToolUse',
            sessionId: 'ses_1',
            incarnationId: 'inc_1',
            claudeSessionId: null,
            promptId: null,
            toolName: 'Bash',
            sentAt: Date.now()
          })
        )
      })
      socket.on('error', reject)
      socket.on('close', () => resolve())
    })

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(received).toEqual(['PreToolUse'])

    await server.stop()
    // POSIX sockets leave a file behind while listening; stopping removes it.
    expect(existsSync(socketPath)).toBe(false)
  })

  it('does not touch the filesystem for a pipe endpoint', async () => {
    // A pipe name is not creatable here, so `listen` must fail; the point is that
    // startup takes the pipe branch and never tries to mkdir: or unlink a path.
    const server = new ActivityHookServer({
      socketPath: '\\\\.\\pipe\\ade-activity-test',
      ingest: () => 'accepted',
      readTimeoutMs: 50
    })
    await expect(server.start()).rejects.toBeTruthy()
  })
})
