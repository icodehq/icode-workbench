/**
 * Hidden Windows wrapper for the WSL lifetime holder.
 *
 * Why this exists. The holder is a long-lived `wsl.exe` that keeps the distro
 * from idling. It must outlive iCode, so it cannot simply be a non-detached child
 * of the Electron main process: iCode's Windows job object kills those when the
 * app exits. But spawning `wsl.exe` with `detached: true` gives the console
 * application its own console, and on Windows 11 with Windows Terminal as the
 * default terminal, `windowsHide: true` does not hide it. The result was a
 * visible, empty terminal window for every WSL host.
 *
 * This wrapper is launched with `ELECTRON_RUN_AS_NODE=1` from the GUI-subsystem
 * iCode executable, so the wrapper itself has no console. It starts `wsl.exe`
 * non-detached with `windowsHide: true`, reports the WSL child's PID through a
 * ready file, and waits for it. The PID recorded as the holder is therefore the
 * actual `wsl.exe` holder, exactly as before this wrapper existed.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  WSL_HOLDER_ARGS_ENV,
  WSL_HOLDER_CWD_ENV,
  WSL_HOLDER_READY_ENV,
  WSL_HOLDER_WSL_ENV,
  type WslHolderReady
} from '../shared/wsl-holder-ready'

function writeReady(readyFile: string, record: WslHolderReady): void {
  mkdirSync(dirname(readyFile), { recursive: true, mode: 0o700 })
  const temp = `${readyFile}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
  renameSync(temp, readyFile)
}

function parseArgs(raw: string | undefined): string[] | null {
  if (raw === undefined) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return null
  return value as string[]
}

/** Reports a pre-child failure where the parent can observe it, then exits. */
function fail(readyFile: string | undefined, detail: string): never {
  if (readyFile !== undefined) {
    try {
      writeReady(readyFile, { error: detail })
    } catch {
      // The parent uses a timeout when even the error cannot be reported.
    }
  }
  process.exit(1)
}

/**
 * Entry point used by `out/host/index.js` when iCode launches it as a holder
 * wrapper. The environment is produced by `spawnDetachedHolder` in
 * `main/wsl/host/holder.ts`; the fields are internal and not user input.
 */
export function runWslHolderFromEnv(env: NodeJS.ProcessEnv): void {
  const readyFile = env[WSL_HOLDER_READY_ENV]
  const wslPath = env[WSL_HOLDER_WSL_ENV]
  const cwd = env[WSL_HOLDER_CWD_ENV]
  const args = parseArgs(env[WSL_HOLDER_ARGS_ENV])
  if (readyFile === undefined || readyFile.length === 0) {
    process.exit(1)
  }
  if (wslPath === undefined || wslPath.length === 0) {
    fail(readyFile, 'The WSL executable path was not supplied to the holder wrapper.')
  }
  if (cwd === undefined || cwd.length === 0) {
    fail(readyFile, 'The holder wrapper received no working directory.')
  }
  if (args === null) {
    fail(readyFile, 'The holder wrapper received invalid WSL arguments.')
  }

  let readyWritten = false
  let child
  try {
    child = spawn(wslPath, args, {
      cwd,
      env: { ...env, WSL_UTF8: '1' },
      // A GUI parent plus a non-detached hidden console child creates no
      // visible terminal; tested against Windows Terminal as the default.
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch (error) {
    fail(readyFile, error instanceof Error ? error.message : String(error))
  }

  child.once('error', (error) => {
    if (readyWritten) {
      process.exit(1)
    }
    fail(readyFile, error.message)
  })
  child.once('spawn', () => {
    const pid = child.pid
    if (pid === undefined) {
      fail(readyFile, 'The WSL holder process did not report a PID.')
    }
    try {
      writeReady(readyFile, { pid })
      readyWritten = true
    } catch (error) {
      try {
        child.kill()
      } catch {
        // The parent's timeout/cleanup path owns this failure.
      }
      process.exit(1)
    }
  })
  child.once('exit', (code) => {
    process.exit(code ?? 0)
  })
}
