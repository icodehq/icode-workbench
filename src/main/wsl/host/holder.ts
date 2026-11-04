/**
 * The Windows-side `wsl.exe` holder: the lifetime anchor for a managed WSL Host.
 *
 * Why a holder exists at all. WSL stops an idle distro, and an idle distro takes
 * its Guest Host down with it. A detached `wsl.exe` that stays attached to the
 * distro is what keeps it alive; `setsid` inside the guest cannot do that,
 * because it detaches the process from a session, not the distro from idling.
 *
 * Two rules hold the whole module together:
 *
 *   1. **Only Windows evidence may touch a Windows process API.** The holder has
 *      a Windows PID, so `process.kill` and the CIM query are legitimate here.
 *      Guest PIDs never reach this file.
 *   2. **Unknown is not dead.** A holder whose evidence cannot be read is
 *      `unverifiable`, and `ensure` refuses to spawn a second holder for it. A
 *      duplicate holder is not harmless: it keeps the distro up after `release`,
 *      and two holders are indistinguishable by intent.
 */

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppError } from '../../../shared/domain/errors'
import { makeAppError } from '../../../shared/domain/errors'
import {
  WSL_HOLDER_ARGS_ENV,
  WSL_HOLDER_CWD_ENV,
  WSL_HOLDER_READY_ENV,
  WSL_HOLDER_WSL_ENV,
  parseWslHolderReady
} from '../../../shared/wsl-holder-ready'
import { resolveWslExecutablePath, resolveWslInteropCwd } from '../exec'
import type { WslHolderRecord, WslHolderState } from './records'
import { parseWslHolderRecord } from './records'
import {
  WSL_HOLDER_MARKER,
  asWindowsProcessId,
  classifyHolderEvidence,
  type WindowsProcessId,
  type WindowsProcessQuery
} from './windows-process'

/**
 * The holder's guest program. A loop of short sleeps, not `sleep infinity`:
 * busybox `sleep` rejects `infinity`, and a single huge duration is parsed
 * differently across implementations.
 */
export const HOLDER_GUEST_SCRIPT = 'while :; do sleep 3600; done'

/**
 * `wsl.exe` argv for one distro's holder.
 *
 * The marker is the `$0` of the guest shell and therefore appears in the Windows
 * command line, which is what later proves this process is ours.
 */
export function buildHolderArgs(distro: string): string[] {
  return ['-d', distro, '--exec', '/bin/sh', '-c', HOLDER_GUEST_SCRIPT, WSL_HOLDER_MARKER]
}

/** One JSON file per distro, keyed case-insensitively as WSL names are. */
export function holderRecordPath(directory: string, distro: string): string {
  return join(directory, `${encodeURIComponent(distro.trim().toLowerCase())}.json`)
}

export type HolderRecordStore = {
  read(distro: string): WslHolderRecord | null
  write(record: WslHolderRecord): void
  remove(distro: string): void
}

/**
 * Durable across a full app quit, on purpose: the holder outlives the app, so
 * the next launch must be able to re-adopt it.
 */
export function createHolderRecordStore(directory: string): HolderRecordStore {
  return {
    read(distro) {
      try {
        return parseWslHolderRecord(readFileSync(holderRecordPath(directory, distro), 'utf8'))
      } catch {
        return null
      }
    },
    write(record) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const target = holderRecordPath(directory, record.distro)
      const temp = `${target}.tmp-${process.pid}`
      writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
      renameSync(temp, target)
    },
    remove(distro) {
      rmSync(holderRecordPath(directory, distro), { force: true })
    }
  }
}

export type HolderSpawnResult = {
  windowsPid: WindowsProcessId
  /**
   * Resolves when the holder wrapper exits. A holder exiting means the distro
   * may have stopped, so the caller must re-check Host liveness rather than
   * assume the Host is gone (or still there).
   */
  exited?: Promise<void>
}

export type HolderSpawn = (
  distro: string
) => HolderSpawnResult | Promise<HolderSpawnResult>

export type HolderDeps = {
  store: HolderRecordStore
  queryProcess: WindowsProcessQuery
  /** Windows-only termination, invoked only for evidence that classified `live`. */
  terminate?: (pid: WindowsProcessId) => void
  spawn?: HolderSpawn
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /**
   * The packaged or built host entry used as the GUI-subsystem wrapper.
   *
   * Production supplies it from the composition root; tests normally inject
   * `spawn` and never need it.
   */
  holderEntryPath?: string
  /** Electron executable used for the wrapper. */
  execPath?: string
  /** Directory for the wrapper's short-lived ready files. */
  readyDirectory?: string
  /** Bound on how long `release` waits for a terminated holder to disappear. */
  releaseTimeoutMs?: number
  /** Notification only: the caller re-checks liveness, this module draws no verdict. */
  onHolderExit?: (distro: string) => void
}

const DEFAULT_RELEASE_TIMEOUT_MS = 5_000
const RELEASE_POLL_MS = 100
const HOLDER_READY_TIMEOUT_MS = 10_000
const HOLDER_READY_POLL_MS = 25

/**
 * Launches the hidden wrapper, which starts `wsl.exe` without a console and
 * reports its PID through a ready file.
 *
 * The recorded PID remains the `wsl.exe` child, not the wrapper: holder
 * identity, adoption after an app restart, and release all keep their existing
 * meaning. The wrapper is only a console-free parent for the WSL process.
 */
function spawnDetachedHolder(deps: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  execPath?: string
  holderEntryPath?: string
  readyDirectory?: string
}): HolderSpawn {
  return async (distro) => {
    if (deps.platform !== 'win32') {
      throw new Error('A WSL holder can only be spawned from Windows.')
    }
    if (deps.execPath === undefined || deps.execPath.length === 0) {
      throw new Error('The Electron executable was not supplied for the WSL holder wrapper.')
    }
    if (deps.holderEntryPath === undefined || deps.holderEntryPath.length === 0) {
      throw new Error('The host entry was not supplied for the WSL holder wrapper.')
    }

    const cwd = resolveWslInteropCwd(deps.env)
    const wslPath = resolveWslExecutablePath(deps.env, deps.platform)
    const readyDirectory = deps.readyDirectory ?? join(tmpdir(), 'ade-wsl-holders')
    mkdirSync(readyDirectory, { recursive: true, mode: 0o700 })
    const readyFile = join(
      readyDirectory,
      `holder-${String(process.pid)}-${String(Date.now())}-${randomUUID()}.json`
    )

    const wrapper = spawn(deps.execPath, [deps.holderEntryPath], {
      cwd,
      env: {
        ...deps.env,
        ELECTRON_RUN_AS_NODE: '1',
        [WSL_HOLDER_READY_ENV]: readyFile,
        [WSL_HOLDER_WSL_ENV]: wslPath,
        [WSL_HOLDER_ARGS_ENV]: JSON.stringify(buildHolderArgs(distro)),
        [WSL_HOLDER_CWD_ENV]: cwd
      },
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    })

    const wrapperPid = wrapper.pid
    if (wrapperPid === undefined) {
      throw new Error('The WSL holder wrapper did not report a Windows PID.')
    }

    let wrapperExited = false
    let wrapperExitDetail = ''
    let wrapperError: Error | null = null
    const exited = new Promise<void>((resolve) => {
      wrapper.once('exit', (code, signal) => {
        wrapperExited = true
        wrapperExitDetail = ` (wrapper exit ${String(code)}${
          signal === null ? '' : `, signal ${signal}`
        })`
        resolve()
      })
      wrapper.once('error', (error) => {
        wrapperError = error
        resolve()
      })
    })

    try {
      const pid = await waitForHolderReady(readyFile, {
        error: () => wrapperError,
        exited: () => wrapperExited,
        exitDetail: () => wrapperExitDetail
      })
      const windowsPid = asWindowsProcessId(pid)
      if (windowsPid === null) throw new Error('The WSL holder reported an invalid Windows PID.')
      rmSync(readyFile, { force: true })
      wrapper.unref()
      return { windowsPid, exited }
    } catch (error) {
      try {
        wrapper.kill()
      } catch {
        // The tree kill below is the authority; the wrapper may already be gone.
      }
      await killWrapperTree(wrapperPid)
      rmSync(readyFile, { force: true })
      wrapper.unref()
      throw error
    }
  }
}

/** Reads the wrapper's ready file; a missing file is not an error yet. */
function readReadyFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

async function waitForHolderReady(
  readyFile: string,
  state: {
    error: () => Error | null
    exited: () => boolean
    exitDetail: () => string
  }
): Promise<number> {
  const deadline = Date.now() + HOLDER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const error = state.error()
    if (error !== null) throw error

    const text = readReadyFile(readyFile)
    if (text !== null) {
      const parsed = parseWslHolderReady(text)
      if (parsed === null) {
        throw new Error('The WSL holder wrapper wrote an invalid ready record.')
      }
      if ('error' in parsed) throw new Error(parsed.error)
      return parsed.pid
    }
    if (state.exited()) {
      throw new Error(
        `The WSL holder wrapper exited before reporting its WSL child${state.exitDetail()}.`
      )
    }
    await new Promise<void>((resolve) => setTimeout(resolve, HOLDER_READY_POLL_MS))
  }
  throw new Error('Timed out waiting for the WSL holder wrapper to report its WSL child.')
}

/**
 * Best-effort cleanup for a wrapper that failed before reporting a child.
 * `taskkill /T` also reaches any `wsl.exe` the wrapper had already started.
 */
function killWrapperTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    execFile(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true },
      () => resolve()
    )
  })
}

export type HolderEnsureOutcome =
  | { outcome: 'adopted'; record: WslHolderRecord; state: 'live' | 'unverifiable'; reason: string }
  | { outcome: 'spawned'; record: WslHolderRecord }
  /** Evidence could not prove the recorded holder dead, so nothing was spawned. */
  | { outcome: 'refused_unverifiable'; record: WslHolderRecord; reason: string }
  | { outcome: 'failed'; error: AppError }

export type HolderReleaseOutcome =
  | { outcome: 'released'; previous: 'live' | 'exited' }
  | { outcome: 'still_running'; record: WslHolderRecord }
  | { outcome: 'unverifiable'; record: WslHolderRecord; reason: string }

export type WslHolder = {
  ensure(distro: string, distroId: string): Promise<HolderEnsureOutcome>
  state(distro: string): Promise<{ state: WslHolderState; record: WslHolderRecord | null }>
  release(distro: string): Promise<HolderReleaseOutcome>
}

export function createWslHolder(deps: HolderDeps): WslHolder {
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const releaseTimeoutMs = deps.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS
  const spawn =
    deps.spawn ??
    spawnDetachedHolder({
      env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform,
      ...(deps.execPath === undefined ? {} : { execPath: deps.execPath }),
      ...(deps.holderEntryPath === undefined ? {} : { holderEntryPath: deps.holderEntryPath }),
      ...(deps.readyDirectory === undefined ? {} : { readyDirectory: deps.readyDirectory })
    })
  /**
   * Terminating a *Windows* pid is the one place this module may do so, and only
   * after `classify` returned `live` (pid + creation time + command line).
   * On Windows `process.kill` terminates; there is no POSIX signal to send.
   */
  const terminate =
    deps.terminate ??
    ((pid: WindowsProcessId) => {
      process.kill(pid)
    })

  async function classify(record: WslHolderRecord) {
    const pid = asWindowsProcessId(record.windowsPid)
    if (pid === null) return { state: 'unverifiable' as const, reason: 'invalid_pid' }
    const evidence = await deps.queryProcess(pid)
    const classification = classifyHolderEvidence(record, evidence, record.distro)
    return {
      state: classification.state,
      reason: classification.reason,
      evidence
    }
  }

  return {
    async ensure(distro, distroId) {
      const existing = deps.store.read(distro)
      if (existing) {
        const classified = await classify(existing)
        if (classified.state === 'live') {
          return {
            outcome: 'adopted',
            record: existing,
            state: 'live',
            reason: classified.reason
          }
        }
        if (classified.state === 'unverifiable') {
          // Never spawn a duplicate: it would be indistinguishable from the
          // recorded one and would keep the distro up after release.
          return {
            outcome: 'refused_unverifiable',
            record: existing,
            reason: classified.reason
          }
        }
        // Proven dead or proven reused: the record describes nothing now.
        deps.store.remove(distro)
      }

      try {
        const spawned = await spawn(distro)
        // A holder that exits may have taken the distro (and Host) with it. The
        // caller re-checks liveness; nothing here decides the Host died.
        void spawned.exited?.then(() => deps.onHolderExit?.(distro))
        const evidence = await deps.queryProcess(spawned.windowsPid)
        const record: WslHolderRecord = {
          version: 1,
          distro,
          distroId,
          windowsPid: spawned.windowsPid,
          // A table that would not answer is recorded as null, never guessed: the
          // command line still proves the process, and a fabricated time would
          // later read as PID reuse.
          creationTimeMs: evidence.status === 'present' ? evidence.creationTimeMs : null,
          startedAtMs: now()
        }
        deps.store.write(record)
        return { outcome: 'spawned', record }
      } catch (error) {
        return {
          outcome: 'failed',
          error: makeAppError('WSL_HOST_START_FAILED', 'Could not start the WSL lifetime holder.', {
            detail: error instanceof Error ? error.message : String(error)
          })
        }
      }
    },

    async state(distro) {
      const record = deps.store.read(distro)
      if (!record) return { state: 'exited', record: null }
      const classified = await classify(record)
      return { state: classified.state, record }
    },

    async release(distro) {
      const record = deps.store.read(distro)
      if (!record) return { outcome: 'released', previous: 'exited' }

      const classified = await classify(record)
      if (classified.state === 'unverifiable') {
        return { outcome: 'unverifiable', record, reason: classified.reason }
      }
      if (classified.state === 'exited') {
        deps.store.remove(distro)
        return { outcome: 'released', previous: 'exited' }
      }

      // Proven live: this is the one place a Windows PID may be terminated.
      const pid = asWindowsProcessId(record.windowsPid)
      if (pid === null) {
        return { outcome: 'unverifiable', record, reason: 'invalid_pid' }
      }
      try {
        terminate(pid)
      } catch {
        return { outcome: 'unverifiable', record, reason: 'termination_failed' }
      }

      const deadline = now() + releaseTimeoutMs
      while (now() < deadline) {
        const evidence = await deps.queryProcess(pid)
        if (evidence.status === 'missing') {
          deps.store.remove(distro)
          return { outcome: 'released', previous: 'live' }
        }
        await sleep(RELEASE_POLL_MS)
      }
      // Report the honest outcome: the holder may still be alive.
      return { outcome: 'still_running', record }
    }
  }
}
