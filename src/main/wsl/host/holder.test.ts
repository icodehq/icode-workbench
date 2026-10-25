import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslHolderRecord } from './records'
import {
  buildHolderArgs,
  createWslHolder,
  HOLDER_GUEST_SCRIPT,
  holderRecordPath,
  type HolderRecordStore
} from './holder'
import { WSL_HOLDER_MARKER, asWindowsProcessId, type WindowsProcessEvidence } from './windows-process'

const DISTRO = 'Ubuntu-26.04'
const ID = 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
const CMD = `wsl.exe -d ${DISTRO} --exec /bin/sh -c ${HOLDER_GUEST_SCRIPT} ${WSL_HOLDER_MARKER}`

function memoryStore(initial: WslHolderRecord | null = null) {
  let record = initial
  const store: HolderRecordStore & { current: () => WslHolderRecord | null } = {
    read: () => record,
    write: (next) => {
      record = next
    },
    remove: () => {
      record = null
    },
    current: () => record
  }
  return store
}

function evidenceFor(options: {
  creationTimeMs?: number | null
  commandLine?: string | null
  missing?: boolean
  unavailable?: boolean
}): WindowsProcessEvidence {
  if (options.unavailable) return { status: 'unavailable' }
  if (options.missing) return { status: 'missing' }
  return {
    status: 'present',
    creationTimeMs: options.creationTimeMs ?? null,
    commandLine: options.commandLine ?? null
  }
}

const RECORD: WslHolderRecord = {
  version: 1,
  distro: DISTRO,
  distroId: ID,
  windowsPid: 4242,
  creationTimeMs: 1_729_000_000_000,
  startedAtMs: 1_729_000_000_100
}

describe('holder command', () => {
  it('targets the distro explicitly and carries the marker as the shell name', () => {
    const args = buildHolderArgs(DISTRO)
    expect(args.slice(0, 4)).toEqual(['-d', DISTRO, '--exec', '/bin/sh'])
    expect(args.at(-1)).toBe(WSL_HOLDER_MARKER)
  })

  it('keeps the distro as one argument even with spaces', () => {
    expect(buildHolderArgs('Ubuntu 24.04 LTS')).toContain('Ubuntu 24.04 LTS')
  })

  it('uses a short-sleep loop, not sleep infinity', () => {
    expect(HOLDER_GUEST_SCRIPT).not.toContain('infinity')
    expect(HOLDER_GUEST_SCRIPT).toContain('sleep 3600')
  })

  it('keys the record file case-insensitively', () => {
    expect(holderRecordPath('/d', 'Ubuntu-26.04')).toBe(holderRecordPath('/d', 'ubuntu-26.04'))
  })
})

describe('holder ensure', () => {
  it('adopts a live recorded holder without spawning', async () => {
    const store = memoryStore(RECORD)
    let spawned = 0
    const holder = createWslHolder({
      store,
      queryProcess: async () =>
        evidenceFor({ creationTimeMs: RECORD.creationTimeMs, commandLine: CMD }),
      spawn: () => {
        spawned += 1
        return { windowsPid: asWindowsProcessId(9999)! }
      }
    })
    const outcome = await holder.ensure(DISTRO, ID)
    expect(outcome.outcome).toBe('adopted')
    expect(spawned).toBe(0)
    expect(store.current()).toEqual(RECORD)
  })

  it('spawns when the recorded holder is provably gone', async () => {
    const store = memoryStore(RECORD)
    const holder = createWslHolder({
      store,
      queryProcess: async () => evidenceFor({ missing: true }),
      spawn: () => ({ windowsPid: asWindowsProcessId(5555)! }),
      now: () => 1_729_000_002_000
    })
    const outcome = await holder.ensure(DISTRO, ID)
    expect(outcome.outcome).toBe('spawned')
    expect(store.current()?.windowsPid).toBe(5555)
  })

  it('spawns when the pid was reused by another process', async () => {
    const store = memoryStore(RECORD)
    const holder = createWslHolder({
      store,
      queryProcess: async () => evidenceFor({ creationTimeMs: 1, commandLine: 'C:\\other.exe' }),
      spawn: () => ({ windowsPid: asWindowsProcessId(5555)! })
    })
    expect((await holder.ensure(DISTRO, ID)).outcome).toBe('spawned')
  })

  it('refuses to spawn a duplicate when evidence is unavailable', async () => {
    // The dangerous case: an unreadable table must not mean "spawn another".
    const store = memoryStore(RECORD)
    let spawned = 0
    const holder = createWslHolder({
      store,
      queryProcess: async () => evidenceFor({ unavailable: true }),
      spawn: () => {
        spawned += 1
        return { windowsPid: asWindowsProcessId(5555)! }
      }
    })
    const outcome = await holder.ensure(DISTRO, ID)
    expect(outcome.outcome).toBe('refused_unverifiable')
    expect(spawned).toBe(0)
    expect(store.current()).toEqual(RECORD)
  })

  it('refuses to spawn a duplicate when the command line is unreadable', async () => {
    const store = memoryStore(RECORD)
    const holder = createWslHolder({
      store,
      queryProcess: async () => evidenceFor({ creationTimeMs: RECORD.creationTimeMs, commandLine: null }),
      spawn: () => ({ windowsPid: asWindowsProcessId(5555)! })
    })
    expect((await holder.ensure(DISTRO, ID)).outcome).toBe('refused_unverifiable')
  })

  it('notifies the caller when a holder it spawned exits, without judging the Host', async () => {
    let exit: (() => void) | null = null
    const exited = new Promise<void>((resolve) => {
      exit = resolve
    })
    const exits: string[] = []
    const holder = createWslHolder({
      store: memoryStore(null),
      queryProcess: async () => evidenceFor({ missing: true }),
      spawn: () => ({ windowsPid: asWindowsProcessId(5555)!, exited }),
      onHolderExit: (distro) => exits.push(distro)
    })
    await holder.ensure(DISTRO, ID)
    expect(exits).toEqual([])
    exit!()
    await Promise.resolve()
    await Promise.resolve()
    expect(exits).toEqual([DISTRO])
  })

  it('records a null creation time when the table would not say', async () => {
    const store = memoryStore(null)
    const holder = createWslHolder({
      store,
      queryProcess: async () => evidenceFor({ creationTimeMs: null, commandLine: CMD }),
      spawn: () => ({ windowsPid: asWindowsProcessId(5555)! })
    })
    await holder.ensure(DISTRO, ID)
    expect(store.current()?.creationTimeMs).toBeNull()
  })

  it('reports a spawn failure as a typed error', async () => {
    const holder = createWslHolder({
      store: memoryStore(null),
      queryProcess: async () => evidenceFor({ missing: true }),
      spawn: () => {
        throw new Error('wsl.exe is missing')
      }
    })
    const outcome = await holder.ensure(DISTRO, ID)
    expect(outcome.outcome).toBe('failed')
    if (outcome.outcome === 'failed') {
      expect(outcome.error.code).toBe('WSL_HOST_START_FAILED')
      expect(outcome.error.detail).toContain('missing')
    }
  })
})

describe('holder release', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('has a production termination channel, so a live holder can actually be released', async () => {
    // Without a default, `release` would report unverifiable forever in production.
    const store = memoryStore(RECORD)
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as never)
    let reads = 0
    const holder = createWslHolder({
      store,
      queryProcess: async () => {
        reads += 1
        if (reads === 1) {
          return evidenceFor({ creationTimeMs: RECORD.creationTimeMs, commandLine: CMD })
        }
        return evidenceFor({ missing: true })
      },
      now: (() => {
        let t = 0
        return () => (t += 10)
      })(),
      sleep: async () => {}
    })
    const outcome = await holder.release(DISTRO)
    expect(kill).toHaveBeenCalledWith(4242)
    expect(outcome.outcome).toBe('released')
  })

  it('terminates only a proven holder, then waits for it to disappear', async () => {
    const store = memoryStore(RECORD)
    const killed: number[] = []
    let reads = 0
    const holder = createWslHolder({
      store,
      queryProcess: async () => {
        reads += 1
        // First read proves it live; later reads show it exiting.
        if (reads === 1) {
          return evidenceFor({ creationTimeMs: RECORD.creationTimeMs, commandLine: CMD })
        }
        return evidenceFor({ missing: true })
      },
      terminate: (pid) => killed.push(pid),
      now: (() => {
        let t = 0
        return () => (t += 10)
      })(),
      sleep: async () => {}
    })
    const outcome = await holder.release(DISTRO)
    expect(killed).toEqual([4242])
    expect(outcome).toEqual({ outcome: 'released', previous: 'live' })
    expect(store.current()).toBeNull()
  })

  it('never terminates an unverifiable holder', async () => {
    const store = memoryStore(RECORD)
    const killed: number[] = []
    const holder = createWslHolder({
      store,
      queryProcess: async () => evidenceFor({ unavailable: true }),
      terminate: (pid) => killed.push(pid)
    })
    const outcome = await holder.release(DISTRO)
    expect(killed).toEqual([])
    expect(outcome.outcome).toBe('unverifiable')
    expect(store.current()).toEqual(RECORD)
  })

  it('reports still_running instead of claiming a stop it did not observe', async () => {
    const store = memoryStore(RECORD)
    const holder = createWslHolder({
      store,
      queryProcess: async () =>
        evidenceFor({ creationTimeMs: RECORD.creationTimeMs, commandLine: CMD }),
      terminate: () => {},
      now: (() => {
        let t = 0
        return () => (t += 1_000)
      })(),
      sleep: async () => {},
      releaseTimeoutMs: 50
    })
    const outcome = await holder.release(DISTRO)
    expect(outcome.outcome).toBe('still_running')
  })

  it('releases a record whose process is already gone', async () => {
    const store = memoryStore(RECORD)
    const holder = createWslHolder({
      store,
      queryProcess: async () => evidenceFor({ missing: true })
    })
    expect(await holder.release(DISTRO)).toEqual({ outcome: 'released', previous: 'exited' })
    expect(store.current()).toBeNull()
  })

  it('releases when nothing was ever recorded', async () => {
    const holder = createWslHolder({
      store: memoryStore(null),
      queryProcess: async () => evidenceFor({ missing: true })
    })
    expect(await holder.release(DISTRO)).toEqual({ outcome: 'released', previous: 'exited' })
  })
})

describe('holder state', () => {
  it('reports exited when nothing is recorded', async () => {
    const holder = createWslHolder({
      store: memoryStore(null),
      queryProcess: async () => evidenceFor({ missing: true })
    })
    expect(await holder.state(DISTRO)).toEqual({ state: 'exited', record: null })
  })

  it('reports unverifiable rather than exited for an unreadable table', async () => {
    const holder = createWslHolder({
      store: memoryStore(RECORD),
      queryProcess: async () => evidenceFor({ unavailable: true })
    })
    expect((await holder.state(DISTRO)).state).toBe('unverifiable')
  })
})
