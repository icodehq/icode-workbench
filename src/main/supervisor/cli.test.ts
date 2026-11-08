import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SupervisorControlServer } from './control-server'
import { supervisorSocketPath } from './endpoint'
import { installSupervisorCli } from './wrappers'
import { makeTempRoot } from '../persistence/persistence-test-fixtures'

const execFileAsync = promisify(execFile)

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe('supervisor CLI', () => {
  it('sends a token, prints JSON, and exits successfully', async () => {
    const root = makeTempRoot('icode-supervisor-cli-')
    const socketPath = supervisorSocketPath({ userDataDir: root.dir })
    const server = new SupervisorControlServer({
      socketPath,
      handle: async (request) => ({
        ok: true,
        value: { op: request.op, token: request.token }
      })
    })
    await server.start()
    cleanups.push(async () => {
      await server.stop()
      root.cleanup()
    })

    const { cliPath } = installSupervisorCli({ directory: root.dir, platform: process.platform })
    const configPath = join(root.dir, 'control.json')
    writeFileSync(
      configPath,
      JSON.stringify({ version: 1, endpoint: socketPath, token: 'secret', repoId: 'repo_1', sessionId: 'ses_1' })
    )

    const output = await execFileAsync(
      process.execPath,
      [cliPath, '--config', configPath, 'state'],
      { encoding: 'utf8' }
    )
    expect(JSON.parse(output.stdout)).toEqual({ op: 'state', token: 'secret' })
  })

  it('exits non-zero and prints the control error', async () => {
    const root = makeTempRoot('icode-supervisor-cli-')
    const socketPath = supervisorSocketPath({ userDataDir: root.dir })
    const server = new SupervisorControlServer({
      socketPath,
      handle: async () => ({
        ok: false,
        error: { code: 'HOST_AUTH_FAILED', message: 'bad token' }
      })
    })
    await server.start()
    cleanups.push(async () => {
      await server.stop()
      root.cleanup()
    })

    const { cliPath } = installSupervisorCli({ directory: root.dir, platform: process.platform })
    const configPath = join(root.dir, 'control.json')
    writeFileSync(
      configPath,
      JSON.stringify({ version: 1, endpoint: socketPath, token: 'bad', repoId: 'repo_1', sessionId: 'ses_1' })
    )

    await expect(
      execFileAsync(process.execPath, [cliPath, '--config', configPath, 'state'], {
        encoding: 'utf8'
      })
    ).rejects.toThrow()
  })
})
