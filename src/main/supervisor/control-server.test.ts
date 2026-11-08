import { afterEach, describe, expect, it } from 'vitest'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { SupervisorControlServer, type SupervisorControlResponse } from './control-server'
import { makeTempRoot } from '../persistence/persistence-test-fixtures'
import { supervisorSocketPath } from './endpoint'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function request(socketPath: string, payload: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let data = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => {
      data += chunk
    })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

describe('supervisor control server', () => {
  it('answers one JSON request per connection', async () => {
    const root = makeTempRoot('icode-supervisor-control-')
    const socketPath = join(root.dir, 'supervisor.sock')
    const server = new SupervisorControlServer({
      socketPath,
      handle: async (incoming): Promise<SupervisorControlResponse> => ({
        ok: true,
        value: { op: incoming.op, input: incoming.input }
      })
    })
    await server.start()
    cleanups.push(async () => {
      await server.stop()
      root.cleanup()
    })

    const raw = await request(socketPath, {
      v: 1,
      token: 'token',
      op: 'state',
      input: { repoId: 'repo_1' }
    })
    expect(JSON.parse(raw)).toEqual({
      ok: true,
      value: { op: 'state', input: { repoId: 'repo_1' } }
    })
  })

  it('returns an error for malformed requests without calling the handler', async () => {
    const root = makeTempRoot('icode-supervisor-control-')
    const socketPath = join(root.dir, 'supervisor.sock')
    let called = 0
    const server = new SupervisorControlServer({
      socketPath,
      handle: async () => {
        called += 1
        return { ok: true, value: null }
      }
    })
    await server.start()
    cleanups.push(async () => {
      await server.stop()
      root.cleanup()
    })

    const raw = await request(socketPath, { v: 1, token: 'token' })
    expect(JSON.parse(raw)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(called).toBe(0)
  })

  it('places the endpoint inside the profile on POSIX and in the pipe namespace on Windows', () => {
    const posix = supervisorSocketPath({
      userDataDir: '/home/me/.config/iCode',
      platform: 'linux'
    })
    expect(posix).toBe('/home/me/.config/iCode/run/supervisor.sock')
    const windows = supervisorSocketPath({
      userDataDir: 'C:\\Users\\me\\AppData\\Roaming\\iCode',
      platform: 'win32'
    })
    expect(windows).toContain('icode-supervisor')
    expect(windows).toContain('\\\\.\\pipe\\')
  })
})
