/**
 * One Git call, routed to the machine that owns the repository.
 *
 * The interface exists for a single reason: `GitWorktreeService` and the review
 * reader must run identical Git invocations against either filesystem without
 * either of them knowing which one they got. It is deliberately tiny — one
 * method, one result type — because a larger abstraction would be a second Git
 * service, which is exactly what must not happen.
 *
 * Routing is **by execution target, never by inspecting the path string**. A
 * guest path such as `/home/u/src/atlas` and a Windows path such as
 * `C:\src\atlas` are both "just strings"; deciding by shape is how a guest path
 * ends up handed to Windows Git.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { WslCommandRunner } from '../wsl/exec'
import { isTransportFailure, runIdempotentGuest } from '../wsl/probe'
import { GuestGitUnavailableError, runGuestGit, type GuestGitResult } from '../wsl/git/guest-git'

export type GitExecRequest = {
  /** Working directory: a Windows path for a local target, a guest path otherwise. */
  cwd: string
  args: readonly string[]
  timeoutMs: number
  signal?: AbortSignal
}

export type GitExecutor = {
  exec(request: GitExecRequest): Promise<GuestGitResult>
}

/**
 * Filesystem questions the caller asks about a repository.
 *
 * These belong to the host that owns the repository, not to the controller. A
 * `statSync('/home/u/src')` on a Windows controller answers about a Windows path
 * that does not exist, which would silently report a healthy WSL worktree as
 * missing.
 */
export type HostFileSystem = {
  isDirectory(path: string): Promise<boolean>
  exists(path: string): Promise<boolean>
  /** Creates the parent of `path`, mode 0700, recursively. */
  ensureParentDirectory(path: string): Promise<void>
  /** True when the directory has no entries; false when it cannot be read. */
  isEmptyDirectory(path: string): Promise<boolean>
  /** Removes an empty directory only. */
  removeDirectory(path: string): Promise<void>
}

export function createLocalHostFileSystem(): HostFileSystem {
  return {
    async isDirectory(path) {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    async exists(path) {
      try {
        statSync(path)
        return true
      } catch {
        return false
      }
    },
    async ensureParentDirectory(path) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    },
    async isEmptyDirectory(path) {
      try {
        return readdirSync(path).length === 0
      } catch {
        return false
      }
    },
    async removeDirectory(path) {
      rmdirSync(path)
    }
  }
}

/** Guest-side capability: one `sh -c` probe per question, argv only. */
export function createGuestHostFileSystem(
  runner: WslCommandRunner,
  distro: string
): HostFileSystem {
  const probe = async (script: string, path: string): Promise<boolean> => {
    // Idempotent question: a timed-out answer is retried once (see wsl/probe.ts).
    const result = await runIdempotentGuest(runner, {
      scope: 'guest',
      distro,
      argv: ['sh', '-c', script, 'ade-fs', path],
      timeoutMs: 10_000
    })
    if ('status' in result) {
      throw new GitUnavailableError('wsl.exe is not available.', distro)
    }
    if (isTransportFailure(result)) {
      /**
       * A timeout or a `wsl.exe` service failure is not an answer.
       *
       * Returning `false` here once reported real guest directories as missing —
       * `CWD_MISSING` and `WORKTREE_MISSING` for folders that were there — because
       * "we could not ask" collapsed into "it is not there". Throwing keeps the
       * distinction, so the user sees an unavailable host, not a phantom deletion.
       */
      throw new GitUnavailableError(
        'The WSL distro did not answer, so this folder could not be checked.',
        `${distro}: ${path}`
      )
    }
    return result.code === 0
  }
  return {
    isDirectory: (path) => probe('test -d "$1"', path),
    exists: (path) => probe('test -e "$1"', path),
    async ensureParentDirectory(path) {
      const parent = path.replace(/\/+[^/]*$/u, '')
      // `mkdir -p` may be repeated safely, so a timed-out attempt is retried.
      const result = await runIdempotentGuest(runner, {
        scope: 'guest',
        distro,
        argv: ['sh', '-c', 'umask 077; mkdir -p "$1"', 'ade-mkdir', parent],
        timeoutMs: 10_000
      })
      if ('status' in result || result.code !== 0) {
        throw new GitUnavailableError('Could not create the worktree directory.', parent)
      }
    },
    async isEmptyDirectory(path) {
      // `ls -A` prints nothing for an empty directory; a failure is "cannot tell".
      const result = await runIdempotentGuest(runner, {
        scope: 'guest',
        distro,
        argv: ['sh', '-c', 'test -d "$1" || exit 1; test -z "$(ls -A "$1")"', 'ade-empty', path],
        timeoutMs: 10_000
      })
      return !('status' in result) && result.code === 0
    },
    async removeDirectory(path) {
      const result = await runner.runBytes({
        scope: 'guest',
        distro,
        argv: ['sh', '-c', 'rmdir "$1"', 'ade-rmdir', path],
        timeoutMs: 10_000
      })
      if ('status' in result || result.code !== 0) {
        throw new GitUnavailableError('Could not remove the empty worktree directory.', path)
      }
    }
  }
}

/** The unchanged local behaviour: `execFile('git', ['-C', cwd, ...args])`. */
export function createLocalGitExecutor(
  options: { env?: NodeJS.ProcessEnv } = {}
): GitExecutor {
  return {
    exec({ cwd, args, timeoutMs, signal }) {
      return new Promise<GuestGitResult>((resolve, reject) => {
        execFile(
          'git',
          ['-C', cwd, ...args],
          {
            timeout: timeoutMs,
            maxBuffer: 64 * 1024 * 1024,
            env: {
              ...(options.env ?? process.env),
              GIT_TERMINAL_PROMPT: '0',
              GIT_OPTIONAL_LOCKS: '0'
            },
            ...(signal ? { signal } : {})
          },
          (error, stdout, stderr) => {
            const out = stdout as unknown as Buffer
            const err = stderr as unknown as Buffer
            if (!error) {
              resolve({ stdout: out, stderr: err, exitCode: 0, timedOut: false })
              return
            }
            const failure = error as NodeJS.ErrnoException & {
              code?: string | number
              killed?: boolean
              signal?: NodeJS.Signals
            }
            if (typeof failure.code === 'string' && failure.code.startsWith('E')) {
              reject(failure)
              return
            }
            resolve({
              stdout: out,
              stderr: err,
              exitCode: typeof failure.code === 'number' ? failure.code : null,
              timedOut: failure.killed === true && (failure.signal ?? null) !== null
            })
          }
        )
      })
    }
  }
}

/** Git in the distro that owns the repository. */
export function createGuestGitExecutor(
  runner: WslCommandRunner,
  distro: string
): GitExecutor {
  return {
    exec({ cwd, args, timeoutMs, signal }) {
      return runGuestGit(runner, {
        distro,
        cwd,
        args,
        timeoutMs,
        ...(signal ? { signal } : {})
      })
    }
  }
}

export class GitUnavailableError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message)
    this.name = 'GitUnavailableError'
  }
}

export type GitExecutorResolution = {
  executor: GitExecutor
  /** Where worktrees for this target live; a guest path for WSL. */
  worktreeRoot: string
  fs: HostFileSystem
}

export type GitExecutorRouter = {
  resolve(target: ExecutionTarget): Promise<GitExecutorResolution>
}

export type GitExecutorRouterDeps = {
  /** Managed local root, unchanged from before W6. */
  localWorktreeRoot: string
  runner: WslCommandRunner
  /** `<guestHome>/.ade/worktrees/<profileScope>`. */
  guestWorktreeRoot: (distro: string) => Promise<string | null>
  localExecutor?: GitExecutor
}

export function createGitExecutorRouter(deps: GitExecutorRouterDeps): GitExecutorRouter {
  const local = deps.localExecutor ?? createLocalGitExecutor()
  const localFs = createLocalHostFileSystem()
  const cache = new Map<string, { executor: GitExecutor; fs: HostFileSystem }>()
  return {
    async resolve(target) {
      if (target.kind === 'local') {
        return { executor: local, worktreeRoot: deps.localWorktreeRoot, fs: localFs }
      }
      if (target.distroId === null) {
        throw new GitUnavailableError(
          'The WSL distro has no registration id, so Git cannot be routed to it.'
        )
      }
      const key = `${target.distro.trim().toLowerCase()}\u0000${target.distroId}`
      let entry = cache.get(key)
      if (!entry) {
        entry = {
          executor: createGuestGitExecutor(deps.runner, target.distro),
          fs: createGuestHostFileSystem(deps.runner, target.distro)
        }
        cache.set(key, entry)
      }
      const root = await deps.guestWorktreeRoot(target.distro)
      if (root === null) {
        throw new GitUnavailableError(
          'The WSL distro did not report a home directory, so its worktree root is unknown.',
          target.distro
        )
      }
      return { executor: entry.executor, worktreeRoot: root, fs: entry.fs }
    }
  }
}

export { GuestGitUnavailableError }
