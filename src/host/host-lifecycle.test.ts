import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { WINDOWS_PIPE_PREFIX, isNamedPipe } from '../shared/domain/endpoint'
import {
  HostStartupError,
  acquireSocketPath,
  hostPathsFromEnv,
  hostSocketPath,
  prepareHostDirectory,
  writeToken
} from './paths'
import { startTerminalHost, type RunningHost } from './server'
import { createFakePtyFactory, FakePty } from './fake-pty'
import { connectTestClient, makeHostPaths } from './test-host'
import { isWindows } from './test-platform'

const roots: string[] = []
const hosts: RunningHost[] = []
const clients: Array<{ close: () => void }> = []

function root(): string {
  // macOS TMPDIR is long enough to hit the sun_path fallback for otherwise
  // ordinary fixtures; a short POSIX root keeps these tests about behavior.
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir()
  const dir = mkdtempSync(join(base, 'icode-life-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close()
  while (hosts.length > 0) {
    const host = hosts.pop()
    host?.stop()
    await host?.stopped
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
  FakePty.reset()
})

describe('startup safety', () => {
  it.skipIf(isWindows)('repairs an exposed directory when chmod is honoured', () => {
    const dir = root()
    const paths = makeHostPaths(dir)
    mkdirSync(paths.dir, { recursive: true })
    chmodSync(paths.dir, 0o777)
    prepareHostDirectory(paths)
    expect((require('node:fs').statSync(paths.dir).mode & 0o777).toString(8)).toBe('700')
  })

  it.skipIf(isWindows)('refuses to start when the filesystem ignores chmod', () => {
    const dir = root()
    const paths = makeHostPaths(dir)
    mkdirSync(paths.dir, { recursive: true })
    chmodSync(paths.dir, 0o777)
    try {
      prepareHostDirectory(paths, { chmod: () => {} })
      throw new Error('expected a permissions failure')
    } catch (error) {
      expect(error).toBeInstanceOf(HostStartupError)
      expect((error as HostStartupError).code).toBe('PERMISSIONS')
    }
  })

  it.skipIf(isWindows)('writes a 0600 token', () => {
    const dir = root()
    const paths = makeHostPaths(dir)
    prepareHostDirectory(paths)
    const token = writeToken(paths.token)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect((require('node:fs').statSync(paths.token).mode & 0o777).toString(8)).toBe('600')
  })

  it.skipIf(isWindows)('refuses a non-socket path without deleting it', async () => {
    const dir = root()
    const paths = makeHostPaths(dir)
    mkdirSync(join(dir, 'socket'), { recursive: true })
    writeFileSync(paths.socket, 'important user file')
    await expect(acquireSocketPath(paths)).rejects.toMatchObject({
      code: 'SOCKET_PATH_INVALID'
    })
    expect(existsSync(paths.socket)).toBe(true)
  })

  it.skipIf(isWindows)('refuses to start when another host is listening', async () => {
    const dir = root()
    const paths = makeHostPaths(dir)
    mkdirSync(join(dir, 'socket'), { recursive: true })
    const listener = createServer()
    await new Promise<void>((resolve) => listener.listen(paths.socket, resolve))
    try {
      await expect(acquireSocketPath(paths)).rejects.toMatchObject({ code: 'SOCKET_IN_USE' })
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
  })

  it.skipIf(isWindows)('scopes the socket to the profile when the runtime dir is shared', () => {
    const runtime = root()
    const alpha = join(root(), 'alpha', 'run')
    const beta = join(root(), 'beta', 'run')

    const first = hostPathsFromEnv({ ICODE_HOST_DIR: alpha, XDG_RUNTIME_DIR: runtime })
    const second = hostPathsFromEnv({ ICODE_HOST_DIR: beta, XDG_RUNTIME_DIR: runtime })

    expect(first.socket).not.toBe(second.socket)
    expect(first.socket.startsWith(join(runtime, 'icode'))).toBe(true)
    // The supervisor derives the same path from the same profile directory.
    expect(first.socket).toBe(
      hostSocketPath({ profileDir: alpha, env: { XDG_RUNTIME_DIR: runtime } })
    )
  })

  it.skipIf(isWindows)(
    'falls back to a short per-profile temp socket when the profile path is too long',
    () => {
      const profile = join(root(), 'p'.repeat(120))
      const socket = hostSocketPath({ profileDir: profile, env: {}, platform: 'linux' })
      expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(100)
      expect(socket.startsWith(tmpdir())).toBe(true)
      expect(dirname(socket)).not.toBe(tmpdir())
    }
  )

  it.skipIf(isWindows)('never chmods the shared temp root for a fallback endpoint', () => {
    const profile = join(root(), 'p'.repeat(120))
    const socket = hostSocketPath({ profileDir: profile, env: {}, platform: 'linux' })
    const dir = join(root(), 'host')
    const paths = {
      dir,
      socket,
      token: join(dir, 'token'),
      meta: join(dir, 'meta.json'),
      log: join(dir, 'host.log')
    }
    const calls: Array<[string, number]> = []
    try {
      prepareHostDirectory(paths, {
        chmod: (path, mode) => {
          calls.push([path, mode])
        }
      })
      expect(calls.some(([path]) => path === tmpdir())).toBe(false)
    } finally {
      rmSync(dirname(socket), { recursive: true, force: true })
    }
  })

  it('lets ICODE_HOST_SOCKET override the profile scope on both sides', () => {
    const explicit = join(root(), 'explicit', 'terminal-host.sock')
    const paths = hostPathsFromEnv({
      ICODE_HOST_DIR: join(root(), 'alpha', 'run'),
      ICODE_HOST_SOCKET: explicit,
      XDG_RUNTIME_DIR: root()
    })
    expect(paths.socket).toBe(explicit)
  })

  it.skipIf(isWindows)('removes a socket whose recorded owner is dead', async () => {
    const dir = root()
    const paths = makeHostPaths(dir)
    mkdirSync(join(dir, 'socket'), { recursive: true })
    mkdirSync(paths.dir, { recursive: true })
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [
        '-e',
        `require('node:net').createServer().listen(${JSON.stringify(paths.socket)})`
      ])
      const tick = setInterval(() => {
        if (existsSync(paths.socket)) {
          clearInterval(tick)
          child.kill('SIGKILL')
        }
      }, 20)
      child.once('exit', () => resolve())
    })
    expect(existsSync(paths.socket)).toBe(true)
    await acquireSocketPath(paths)
    expect(existsSync(paths.socket)).toBe(false)
  })

  it.skipIf(isWindows)('keeps a stale-looking socket when the recorded host is alive', async () => {
    const dir = root()
    const paths = makeHostPaths(dir)
    mkdirSync(join(dir, 'socket'), { recursive: true })
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(
      paths.meta,
      JSON.stringify({ pid: process.pid, startedAt: 1, socket: paths.socket })
    )
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [
        '-e',
        `require('node:net').createServer().listen(${JSON.stringify(paths.socket)})`
      ])
      const tick = setInterval(() => {
        if (existsSync(paths.socket)) {
          clearInterval(tick)
          child.kill('SIGKILL')
        }
      }, 20)
      child.once('exit', () => resolve())
    })
    await expect(acquireSocketPath(paths)).rejects.toMatchObject({
      code: 'SOCKET_STALE_UNSAFE'
    })
    expect(existsSync(paths.socket)).toBe(true)
  })
})

describe('running host', () => {
  async function startHost(): Promise<{ host: RunningHost; fake: ReturnType<typeof createFakePtyFactory> }> {
    const fake = createFakePtyFactory()
    const host = await startTerminalHost({
      paths: makeHostPaths(root()),
      shell: '/bin/bash',
      ptyFactory: fake.factory
    })
    hosts.push(host)
    return { host, fake }
  }

  function createParams(sessionId: string) {
    return { sessionId, cwd: process.cwd(), command: '/bin/bash', cols: 80, rows: 24 }
  }

  it('serves sessions and refuses idle shutdown while they are live', async () => {
    const { host, fake } = await startHost()
    const client = await connectTestClient(host.paths, host.token)
    clients.push(client)
    const created = await client.request('createOrAttach', createParams('ses_life-1'))
    expect(created).toMatchObject({ ok: true })
    expect(fake.instances).toHaveLength(1)

    const refused = await client.request('shutdownIfIdle')
    expect(refused.payload).toMatchObject({ shutdown: false, reason: 'live_sessions' })

    fake.instances[0]!.emitExit({ exitCode: 0 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const allowed = await client.request('shutdownIfIdle')
    expect(allowed.payload).toMatchObject({ shutdown: true, reason: 'idle' })
    await host.stopped
    expect(existsSync(host.paths.socket)).toBe(false)
    expect(existsSync(host.paths.token)).toBe(false)
    hosts.splice(hosts.indexOf(host), 1)
  })

  it('kills owned PTYs and removes runtime files on explicit shutdown', async () => {
    const { host, fake } = await startHost()
    const client = await connectTestClient(host.paths, host.token)
    clients.push(client)
    await client.request('createOrAttach', createParams('ses_life-2'))
    if (!isWindows) expect(existsSync(host.paths.socket)).toBe(true)
    expect(existsSync(host.paths.token)).toBe(true)

    await client.request('shutdown')
    await host.stopped
    expect(fake.instances[0]!.killed).toBe(true)
    expect(existsSync(host.paths.socket)).toBe(false)
    expect(existsSync(host.paths.token)).toBe(false)
    expect(existsSync(host.paths.meta)).toBe(false)
    hosts.splice(hosts.indexOf(host), 1)
  })

  it.skipIf(isWindows)('records effective permissions in metadata', async () => {
    const { host } = await startHost()
    const meta = JSON.parse(require('node:fs').readFileSync(host.paths.meta, 'utf8')) as {
      dirMode: string
      tokenMode: string
      socketMode: string
      protocolVersion: number
      hostVersion: string
    }
    expect(meta).toMatchObject({
      dirMode: '700',
      tokenMode: '600',
      socketMode: '600',
      protocolVersion: 1
    })
    expect(meta.hostVersion).toContain('icode1')
    host.stop()
    await host.stopped
    hosts.splice(hosts.indexOf(host), 1)
  })
})

describe('Windows endpoint selection', () => {
  it('uses a named pipe instead of a filesystem path', () => {
    const profile = join(root(), 'windows-profile')
    const socket = hostSocketPath({
      profileDir: profile,
      env: {},
      platform: 'win32'
    })

    expect(isNamedPipe(socket)).toBe(true)
    expect(socket.startsWith(WINDOWS_PIPE_PREFIX)).toBe(true)
    expect(socket.endsWith('.sock')).toBe(false)
  })

  it('isolates two profiles and stays deterministic', () => {
    const alpha = join(root(), 'alpha')
    const beta = join(root(), 'beta')
    const first = hostSocketPath({ profileDir: alpha, env: {}, platform: 'win32' })
    const again = hostSocketPath({ profileDir: alpha, env: {}, platform: 'win32' })
    const other = hostSocketPath({ profileDir: beta, env: {}, platform: 'win32' })

    expect(first).toBe(again)
    expect(first).not.toBe(other)
  })

  it('honours ICODE_HOST_SOCKET on Windows', () => {
    const explicit = '\\\\.\\pipe\\icode-test-pinned'
    const socket = hostSocketPath({
      profileDir: join(root(), 'p'),
      env: { ICODE_HOST_SOCKET: explicit },
      platform: 'win32'
    })
    expect(socket).toBe(explicit)
  })

  it('server and client derive the same endpoint from the same profile', () => {
    const dir = join(root(), 'shared-profile')
    // The host process reads ICODE_HOST_DIR; the supervisor uses its directory.
    const hostSide = hostPathsFromEnv({
      ICODE_HOST_DIR: dir,
      ICODE_HOST_SOCKET: hostSocketPath({ profileDir: dir, env: {}, platform: 'win32' })
    })
    const clientSide = hostSocketPath({ profileDir: dir, env: {}, platform: 'win32' })
    expect(hostSide.socket).toBe(clientSide)
  })

  it('does not create or remove a directory for a pipe endpoint', () => {
    const dir = join(root(), 'pipe-dir')
    const paths = {
      dir,
      socket: '\\\\.\\pipe\\icode-host-test',
      token: join(dir, 'token'),
      meta: join(dir, 'meta.json'),
      log: join(dir, 'host.log')
    }
    // Must not attempt mkdir of `\\.\pipe`.
    expect(() => prepareHostDirectory(paths)).not.toThrow()
    expect(existsSync(dir)).toBe(true)
    // Nothing to acquire or unlink for a pipe.
    return expect(acquireSocketPath(paths)).resolves.toBeUndefined()
  })
})
