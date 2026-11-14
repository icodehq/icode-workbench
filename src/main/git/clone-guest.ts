/**
 * `git clone` inside a distro, with progress streaming.
 *
 * This mirrors the direct-git/login-shell split used by every other guest Git
 * call, but through `WslCommandRunner.runStream` instead of the buffered
 * runner. The login-shell fallback still fences stdout; progress is written to
 * stderr, so banners cannot corrupt it.
 */

import type { WslCommandRunner, WslStreamResult } from '../wsl/exec'
import {
  fencedCommand,
  isDirectGuestGitNotFound
} from '../wsl/git/guest-git-environment'
import {
  GUEST_GIT_ENV,
  quoteForShell,
  sharedGuestGitEnvironments
} from '../wsl/git/guest-git'

export type StreamingGuestCloneInput = {
  runner: WslCommandRunner
  distro: string
  url: string
  destination: string
  timeoutMs: number
  signal?: AbortSignal
  onStderr?: (chunk: Buffer) => void
}

/** Keeps just enough stderr to decide whether the direct route was stale. */
function createStderrTail(): { push(chunk: Buffer): void; text(): string } {
  const chunks: Buffer[] = []
  let bytes = 0
  return {
    push(chunk) {
      chunks.push(chunk)
      bytes += chunk.length
      while (bytes > 8_192 && chunks.length > 1) {
        bytes -= chunks[0]!.length
        chunks.shift()
      }
    },
    text() {
      return Buffer.concat(chunks).toString('utf8')
    }
  }
}

export async function runStreamingGuestClone(
  input: StreamingGuestCloneInput
): Promise<WslStreamResult> {
  const environments = sharedGuestGitEnvironments(input.runner)
  const probed = await environments.probe(input.distro, {
    ...(input.signal ? { signal: input.signal } : {})
  })

  if (probed.kind === 'resolved') {
    const tail = createStderrTail()
    const direct = await input.runner.runStream(
      {
        scope: 'guest',
        label: 'git-clone',
        distro: input.distro,
        argv: [
          '/usr/bin/env',
          `PATH=${probed.environment.path}`,
          `HOME=${probed.environment.home}`,
          ...GUEST_GIT_ENV,
          probed.environment.gitPath,
          'clone',
          '--progress',
          '--',
          input.url,
          input.destination
        ],
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {})
      },
      {
        onStderr: (chunk) => {
          tail.push(chunk)
          input.onStderr?.(chunk)
        }
      }
    )
    if (
      !direct.timedOut &&
      !direct.cancelled &&
      isDirectGuestGitNotFound({ exitCode: direct.code, stderr: Buffer.from(tail.text()) })
    ) {
      // The probe's route is stale; re-probe next time and try the login shell.
      environments.invalidate(input.distro)
    } else {
      return direct
    }
  }

  return input.runner.runStream(
    {
      scope: 'guest',
      label: 'git-clone-shell',
      distro: input.distro,
      argv: [
        'sh',
        '-lc',
        fencedCommand(
          ['git', 'clone', '--progress', '--', input.url, input.destination]
            .map(quoteForShell)
            .join(' ')
        )
      ],
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {})
    },
    { onStderr: input.onStderr }
  )
}
