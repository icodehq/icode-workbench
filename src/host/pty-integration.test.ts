import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import * as pty from 'node-pty'
import { PtyRegistry, type PtySpawnConfig } from './pty-registry'
import { isWindows } from './test-platform'
import type { HostEvent } from '../shared/host-protocol'

const SHELL = '/bin/bash'
const ARGS = ['--noprofile', '--norc']
const registries: PtyRegistry[] = []

function realFactory(config: PtySpawnConfig) {
  return pty.spawn(config.command, config.args, {
    name: 'xterm-256color',
    cols: config.cols,
    rows: config.rows,
    cwd: config.cwd,
    env: config.env
  })
}

function setup(): { registry: PtyRegistry; events: HostEvent[]; waitFor: (predicate: (event: HostEvent) => boolean, timeoutMs?: number) => Promise<HostEvent> } {
  const events: HostEvent[] = []
  const waiters: Array<{ predicate: (event: HostEvent) => boolean; resolve: (event: HostEvent) => void }> = []
  const record = (event: HostEvent): void => {
    events.push(event)
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i]!.predicate(event)) {
        const waiter = waiters[i]!
        waiters.splice(i, 1)
        waiter.resolve(event)
      }
    }
  }
  const registry = new PtyRegistry({
    ptyFactory: realFactory,
    events: {
      onData: (event) => record({ type: 'event', event: 'data', ...event }),
      onSpawned: (event) => record({ type: 'event', event: 'spawned', ...event }),
      onExit: (event) => record({ type: 'event', event: 'exit', ...event })
    },
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
  })
  registries.push(registry)
  return {
    registry,
    events,
    waitFor: (predicate, timeoutMs = 5000) => {
      const existing = events.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for PTY event')), timeoutMs)
        waiters.push({
          predicate,
          resolve: (event) => {
            clearTimeout(timer)
            resolve(event)
          }
        })
      })
    }
  }
}

function createParams(sessionId: string, cwd = process.cwd(), cols = 100, rows = 30) {
  return {
    sessionId,
    cwd,
    command: SHELL,
    args: ARGS,
    cols,
    rows
  }
}

afterEach(() => {
  while (registries.length > 0) registries.pop()?.closeAll()
})

describe.skipIf(isWindows)('real PTY sessions', () => {
  it('spawns a shell, accepts input, and produces output', async () => {
    const { registry, waitFor } = setup()
    const created = registry.createOrAttach(createParams('ses_real-echo'))
    expect(created.info.ptyPid).toBeGreaterThan(0)
    expect(created.info.status).toBe('live')

    const marker = `ICODE_REAL_${Date.now()}`
    registry.write('ses_real-echo', created.info.incarnationId, `printf '%s\\n' ${marker}\n`)
    const event = await waitFor(
      (item) => item.event === 'data' && item.data.includes(marker)
    )
    expect(event.event).toBe('data')

    const snapshot = await registry.snapshot('ses_real-echo')
    expect(snapshot.data).toContain(marker)
    expect(snapshot.seq).toBeGreaterThan(0)
  })

  it('captures the exit code when the process ends', async () => {
    const { registry, waitFor } = setup()
    const created = registry.createOrAttach(createParams('ses_real-exit'))
    registry.write('ses_real-exit', created.info.incarnationId, 'exit 3\n')
    const exit = await waitFor((item) => item.event === 'exit')
    expect(exit).toMatchObject({ sessionId: 'ses_real-exit', exitCode: 3 })
    expect(registry.list()[0]!.status).toBe('failed')
    const snapshot = await registry.snapshot('ses_real-exit')
    expect(snapshot.seq).toBeGreaterThan(0)
  })

  it('recovers alternate-screen output from a real PTY', async () => {
    const { registry, waitFor } = setup()
    const created = registry.createOrAttach(createParams('ses_real-alt'))
    const incarnation = created.info.incarnationId
    // Enter the alternate screen, draw a box, move the cursor.
    registry.write(
      'ses_real-alt',
      incarnation,
      "printf '\\033[?1049h\\033[2J\\033[HALT-SCREEN\\nline-two\\033[2;3H'; sleep 1\n"
    )
    await waitFor((item) => item.event === 'data' && item.data.includes('line-two'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    const snapshot = await registry.snapshot('ses_real-alt')
    expect(snapshot.alternateScreen).toBe(true)
    expect(snapshot.data).toContain('ALT-SCREEN')
    expect(snapshot.cursor).toEqual({ x: 2, y: 1 })
  })

  it('isolates input, output, and kill between two sessions', async () => {
    const { registry, waitFor } = setup()
    const a = registry.createOrAttach(createParams('ses_real-iso-a'))
    const b = registry.createOrAttach(createParams('ses_real-iso-b'))
    expect(a.info.ptyPid).not.toBe(b.info.ptyPid)

    registry.write('ses_real-iso-a', a.info.incarnationId, "printf 'ONLY-A\\n'\n")
    await waitFor((item) => item.event === 'data' && item.data.includes('ONLY-A'))
    const snapshotB = await registry.snapshot('ses_real-iso-b')
    expect(snapshotB.data).not.toContain('ONLY-A')

    registry.kill('ses_real-iso-a')
    await waitFor(
      (item) => item.event === 'exit' && item.sessionId === 'ses_real-iso-a'
    )
    const listed = registry.list()
    expect(listed.find((entry) => entry.sessionId === 'ses_real-iso-b')?.status).toBe('live')
    expect(listed.find((entry) => entry.sessionId === 'ses_real-iso-a')?.status).not.toBe('live')

    // B still accepts input after A is killed.
    registry.write('ses_real-iso-b', b.info.incarnationId, "printf 'B-ALIVE\\n'\n")
    await waitFor((item) => item.event === 'data' && item.data.includes('B-ALIVE'))
  })

  it('applies resize to the addressed PTY and reports dimensions', async () => {
    const { registry } = setup()
    const created = registry.createOrAttach(createParams('ses_real-resize', process.cwd(), 80, 24))
    registry.resize('ses_real-resize', created.info.incarnationId, 132, 43)
    const info = registry.list()[0]!
    expect(info.cols).toBe(132)
    expect(info.rows).toBe(43)
    const snapshot = await registry.snapshot('ses_real-resize')
    expect(snapshot).toMatchObject({ cols: 132, rows: 43 })
  })

  it('restarts a real session with a new PTY and a fresh screen', async () => {
    const { registry, waitFor } = setup()
    const first = registry.createOrAttach(createParams('ses_real-restart'))
    registry.write('ses_real-restart', first.info.incarnationId, "printf 'OLD-SCREEN\\n'; exit 0\n")
    await waitFor((item) => item.event === 'exit')

    const restarted = registry.createOrAttach(createParams('ses_real-restart'))
    expect(restarted.created).toBe(true)
    expect(restarted.info.incarnationId).not.toBe(first.info.incarnationId)
    expect(restarted.info.ptyPid).not.toBe(first.info.ptyPid)
    const snapshot = await registry.snapshot('ses_real-restart')
    expect(snapshot.data).not.toContain('OLD-SCREEN')
  })

  it('reports a missing binary as a failed process, not a phantom live session', async () => {
    const { registry, waitFor } = setup()
    // node-pty spawns and the OS reports the failure through the PTY; the host
    // must surface that exit rather than leaving a session marked live.
    registry.createOrAttach({
      sessionId: 'ses_real-missing',
      cwd: process.cwd(),
      command: '/definitely/not/a/binary',
      cols: 80,
      rows: 24
    })
    const exit = await waitFor((item) => item.event === 'exit')
    expect(exit.event).toBe('exit')
    if (exit.event !== 'exit') return
    expect(exit.exitCode).not.toBe(0)
    const info = registry.list()[0]!
    expect(info.status).toBe('failed')
    expect(info.exitCode).not.toBe(0)
    expect(registry.liveCount()).toBe(0)
  })

  it('uses the requested working directory', async () => {
    const { registry, waitFor } = setup()
    const cwd = execFileSync('realpath', [process.cwd()]).toString().trim()
    const created = registry.createOrAttach(createParams('ses_real-cwd', cwd))
    registry.write('ses_real-cwd', created.info.incarnationId, 'pwd\n')
    await waitFor((item) => item.event === 'data' && item.data.includes(cwd))
    const snapshot = await registry.snapshot('ses_real-cwd')
    expect(snapshot.data).toContain(cwd)
  })
})

/**
 * cmd.exe has no POSIX shell semantics, so the POSIX suite above is skipped and
 * these are the equivalents that matter on Windows: input, output, exit truth,
 * working directory, and kill isolation through ConPTY.
 */
describe.runIf(isWindows)('real PTY sessions (Windows)', () => {
  const CMD = process.env.ComSpec ?? 'cmd.exe'

  function windowsParams(sessionId: string, cwd = process.cwd()) {
    return { sessionId, cwd, command: CMD, args: [], cols: 100, rows: 30 }
  }

  it('spawns cmd.exe, accepts input, and produces output', async () => {
    const { registry, waitFor } = setup()
    const created = registry.createOrAttach(windowsParams('ses_win-echo'))
    const marker = `ICODE_WIN_${Date.now()}`
    registry.write('ses_win-echo', created.info.incarnationId, `echo ${marker}\r\n`)
    await waitFor((item) => item.event === 'data' && item.data.includes(marker))
    const snapshot = await registry.snapshot('ses_win-echo')
    expect(snapshot.data).toContain(marker)
  })

  it('captures a nonzero exit code', async () => {
    const { registry, waitFor } = setup()
    const created = registry.createOrAttach(windowsParams('ses_win-exit'))
    registry.write('ses_win-exit', created.info.incarnationId, 'exit 3\r\n')
    const exit = await waitFor((item) => item.event === 'exit')
    expect(exit).toMatchObject({ sessionId: 'ses_win-exit', exitCode: 3 })
    expect(registry.list()[0]!.status).toBe('failed')
  })

  it('uses the requested working directory', async () => {
    const { registry, waitFor } = setup()
    const cwd = realpathSync.native(process.cwd())
    const created = registry.createOrAttach(windowsParams('ses_win-cwd', cwd))
    registry.write('ses_win-cwd', created.info.incarnationId, 'cd\r\n')
    await waitFor(
      (item) => item.event === 'data' && item.data.toLowerCase().includes(cwd.toLowerCase())
    )
    const snapshot = await registry.snapshot('ses_win-cwd')
    expect(snapshot.data.toLowerCase()).toContain(cwd.toLowerCase())
  })

  it('isolates kill between two cmd.exe sessions', async () => {
    const { registry, waitFor } = setup()
    const a = registry.createOrAttach(windowsParams('ses_win-iso-a'))
    const b = registry.createOrAttach(windowsParams('ses_win-iso-b'))
    registry.write('ses_win-iso-a', a.info.incarnationId, 'echo ONLY-A\r\n')
    await waitFor((item) => item.event === 'data' && item.data.includes('ONLY-A'))
    const snapshotB = await registry.snapshot('ses_win-iso-b')
    expect(snapshotB.data).not.toContain('ONLY-A')

    registry.kill('ses_win-iso-a')
    await waitFor((item) => item.event === 'exit' && item.sessionId === 'ses_win-iso-a')
    const listed = registry.list()
    expect(listed.find((entry) => entry.sessionId === 'ses_win-iso-b')?.status).toBe('live')

    // B still accepts input after A is killed.
    registry.write('ses_win-iso-b', b.info.incarnationId, 'echo B-ALIVE\r\n')
    await waitFor((item) => item.event === 'data' && item.data.includes('B-ALIVE'))
  })
})
