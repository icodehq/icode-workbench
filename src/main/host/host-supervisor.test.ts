import { createServer, type Server } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The supervisor reads Electron's `app` for the default profile and host entry;
// a stub keeps these tests about paths and ownership, not a real app launch.
const appStub = {
  isPackaged: false,
  getAppPath: () => join(roots[0] ?? tmpdir(), 'app'),
  getPath: () => join(roots[0] ?? tmpdir(), 'profile')
}
vi.mock('electron', () => ({ app: appStub }))

const { HostSupervisor } = await import('./host-supervisor')
const { hostSocketPath, profileSocketScope } = await import('../../host/paths')

const roots: string[] = []
const servers: Server[] = []
const savedEnv = { ...process.env }

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'icode-supervisor-'))
  roots.push(dir)
  return dir
}

function profile(name: string): string {
  const dir = join(root(), name, 'run')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function writeMeta(dir: string, pid: number, socket: string): void {
  writeFileSync(
    join(dir, 'meta.json'),
    `${JSON.stringify({ pid, startedAt: 1, protocolVersion: 1, hostVersion: 'test', socket, tokenFile: join(dir, 'token') })}\n`,
    { mode: 0o600 }
  )
}

function listen(socketPath: string): Promise<Server> {
  mkdirSync(join(socketPath, '..'), { recursive: true, mode: 0o700 })
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end())
    servers.push(server)
    server.once('error', reject)
    server.listen(socketPath, () => resolve(server))
  })
}

function accepts(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { connect } = require('node:net') as typeof import('node:net')
    const socket = connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 1_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    await new Promise<void>((resolve) => {
      if (!server || !server.listening) return resolve()
      server.close(() => resolve())
    })
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
  process.env = { ...savedEnv }
})

describe.skipIf(process.platform === 'win32')('profile-scoped socket path', () => {
  it('gives two profiles sharing one runtime directory different sockets', () => {
    const runtime = root()
    process.env.XDG_RUNTIME_DIR = runtime
    delete process.env.ICODE_HOST_SOCKET

    const first = new HostSupervisor(profile('alpha')).socketPath
    const second = new HostSupervisor(profile('beta')).socketPath

    expect(first).not.toBe(second)
    expect(first.startsWith(join(runtime, 'icode'))).toBe(true)
    expect(second.startsWith(join(runtime, 'icode'))).toBe(true)
    // Still a legal Unix socket path (sun_path is 108 bytes).
    expect(Buffer.byteLength(first)).toBeLessThan(107)
  })

  it('is deterministic for the same profile and ignores a trailing slash', () => {
    process.env.XDG_RUNTIME_DIR = root()
    delete process.env.ICODE_HOST_SOCKET
    const dir = profile('alpha')
    expect(new HostSupervisor(dir).socketPath).toBe(new HostSupervisor(dir).socketPath)
    expect(profileSocketScope(dir)).toBe(profileSocketScope(`${dir}/`))
  })

  it('keeps the fallback per-profile when there is no runtime directory', () => {
    delete process.env.XDG_RUNTIME_DIR
    delete process.env.ICODE_HOST_SOCKET
    const firstDir = profile('alpha')
    const secondDir = profile('beta')
    const first = new HostSupervisor(firstDir).socketPath
    const second = new HostSupervisor(secondDir).socketPath
    expect(first).toBe(join(firstDir, 'terminal-host.sock'))
    expect(second).toBe(join(secondDir, 'terminal-host.sock'))
    expect(first).not.toBe(second)
  })

  it('keeps the scoped path when a long runtime dir would overflow sun_path', () => {
    const long = join(root(), 'r'.repeat(80))
    const dir = profile('alpha')
    const path = hostSocketPath({
      profileDir: dir,
      env: { XDG_RUNTIME_DIR: long, ICODE_HOST_SOCKET: undefined }
    })
    expect(path).toBe(join(dir, 'terminal-host.sock'))
    expect(Buffer.byteLength(path)).toBeLessThan(107)
  })

  it('honours ICODE_HOST_SOCKET as an explicit override', () => {
    process.env.XDG_RUNTIME_DIR = root()
    const explicit = join(root(), 'override', 'terminal-host.sock')
    process.env.ICODE_HOST_SOCKET = explicit
    expect(new HostSupervisor(profile('alpha')).socketPath).toBe(explicit)
  })

  it('keeps override sockets ownership-safe too', async () => {
    const explicit = join(root(), 'override', 'terminal-host.sock')
    process.env.ICODE_HOST_SOCKET = explicit
    const supervisor = new HostSupervisor(profile('alpha'))
    await listen(explicit)

    await expect(supervisor.ensure()).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' })
    await expect(accepts(explicit)).resolves.toBe(true)
    expect(existsSync(explicit)).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('ownership-safe discovery', () => {
  it('never unlinks a live socket this profile does not own', async () => {
    const runtime = root()
    process.env.XDG_RUNTIME_DIR = runtime
    delete process.env.ICODE_HOST_SOCKET
    const dir = profile('alpha')
    const supervisor = new HostSupervisor(dir)
    await listen(supervisor.socketPath)

    // No meta.json and no token: nothing proves this profile owns the endpoint.
    await expect(supervisor.ensure()).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' })
    await expect(accepts(supervisor.socketPath)).resolves.toBe(true)
    expect(existsSync(supervisor.socketPath)).toBe(true)
  })

  it('reports a live recorded pid whose endpoint is gone without touching it', async () => {
    const runtime = root()
    process.env.XDG_RUNTIME_DIR = runtime
    delete process.env.ICODE_HOST_SOCKET
    const dir = profile('alpha')
    const supervisor = new HostSupervisor(dir)
    // Our own pid stands in for a live host.
    writeMeta(dir, process.pid, supervisor.socketPath)

    await expect(supervisor.ensure()).rejects.toMatchObject({
      code: 'HOST_UNREACHABLE',
      message: expect.stringContaining(String(process.pid))
    })
    // The recorded metadata survives, and no process was signalled.
    expect(existsSync(join(dir, 'meta.json'))).toBe(true)
    expect(readFileSync(join(dir, 'meta.json'), 'utf8')).toContain(String(process.pid))
    expect(() => process.kill(process.pid, 0)).not.toThrow()
  })

  it('describes a legacy endpoint recorded beside a scoped one', async () => {
    process.env.XDG_RUNTIME_DIR = root()
    delete process.env.ICODE_HOST_SOCKET
    const dir = profile('alpha')
    const supervisor = new HostSupervisor(dir)
    const legacy = join(roots[0]!, 'legacy', 'terminal-host.sock')
    writeMeta(dir, process.pid, legacy)

    const error = await supervisor.ensure().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'HOST_UNREACHABLE' })
    expect(String((error as Error).message)).toContain(legacy)
    expect(String((error as Error).message)).toContain(supervisor.socketPath)
  })

  it('leaves an unprobeable endpoint alone instead of guessing', async () => {
    process.env.XDG_RUNTIME_DIR = root()
    delete process.env.ICODE_HOST_SOCKET
    const dir = profile('alpha')
    const supervisor = new HostSupervisor(dir)
    // A regular file is not a socket: connecting is inconclusive, not "stale".
    mkdirSync(join(supervisor.socketPath, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(supervisor.socketPath, 'do not delete me')

    await expect(supervisor.ensure()).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' })
    expect(readFileSync(supervisor.socketPath, 'utf8')).toBe('do not delete me')
  })

  it('delegates stale-socket removal to the Host instead of unlinking it', async () => {
    process.env.XDG_RUNTIME_DIR = root()
    delete process.env.ICODE_HOST_SOCKET
    const supervisor = new HostSupervisor(profile('alpha'))
    // A killed listener leaves its socket file behind and refuses connections:
    // exactly the case the Host is allowed to clean up.
    mkdirSync(join(supervisor.socketPath, '..'), { recursive: true, mode: 0o700 })
    await new Promise<void>((resolve) => {
      const { spawn } = require('node:child_process') as typeof import('node:child_process')
      const child = spawn(process.execPath, [
        '-e',
        `require('node:net').createServer().listen(${JSON.stringify(supervisor.socketPath)})`
      ])
      const tick = setInterval(() => {
        if (existsSync(supervisor.socketPath)) {
          clearInterval(tick)
          child.kill('SIGKILL')
        }
      }, 20)
      child.once('exit', () => {
        clearInterval(tick)
        resolve()
      })
    })
    expect(existsSync(supervisor.socketPath)).toBe(true)

    // No metadata and no built Host entry: the supervisor must reach the spawn
    // step (HOST_CONNECT_FAILED) rather than refuse ownership, and must not
    // unlink the stale path itself.
    await expect(supervisor.ensure()).rejects.toMatchObject({ code: 'HOST_CONNECT_FAILED' })
    expect(existsSync(supervisor.socketPath)).toBe(true)
  })

  it('starts a Host only when the endpoint is absent', async () => {
    process.env.XDG_RUNTIME_DIR = root()
    delete process.env.ICODE_HOST_SOCKET
    const supervisor = new HostSupervisor(profile('alpha'))
    // No built Host entry in this fixture: spawning is attempted and fails
    // cleanly, which proves ensure() reached the spawn step (absent endpoint).
    await expect(supervisor.ensure()).rejects.toMatchObject({ code: 'HOST_CONNECT_FAILED' })
    expect(existsSync(supervisor.socketPath)).toBe(false)
  })
})

describe('named-pipe endpoints', () => {
  it('derives a profile-scoped pipe on Windows', () => {
    const pipe = hostSocketPath({
      profileDir: 'C:\\Users\\a\\AppData\\Roaming\\iCode\\run',
      env: {},
      platform: 'win32'
    })
    expect(pipe.startsWith('\\\\.\\pipe\\icode-host-')).toBe(true)
  })

  it('treats an absent named pipe as startable', async () => {
    process.env.ICODE_HOST_SOCKET = `\\\\.\\pipe\\icode-supervisor-absent-${process.pid}-${Date.now()}`
    const supervisor = new HostSupervisor(profile('pipe-absent'))
    // A pipe is not a filesystem object. The supervisor must reach the spawn
    // step (and fail on the missing fixture entry), not refuse ownership.
    await expect(supervisor.ensure()).rejects.toThrow(/Terminal host entry is missing/)
  })

  it.skipIf(process.platform !== 'win32')(
    'refuses a live pipe without matching credentials',
    async () => {
      const pipe = `\\\\.\\pipe\\icode-supervisor-live-${process.pid}-${Date.now()}`
      const server = createServer((socket) => socket.end())
      servers.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(pipe, resolve)
      })

      process.env.ICODE_HOST_SOCKET = pipe
      const supervisor = new HostSupervisor(profile('pipe-live'))
      // Before the named-pipe branch, existsSync was always false here and the
      // supervisor would try to start a second Host instead of refusing.
      await expect(supervisor.ensure()).rejects.toThrow(/no matching credentials/)
    }
  )
})
