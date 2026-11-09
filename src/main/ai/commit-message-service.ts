/**
 * AI commit-message generation, scoped to one session's worktree.
 *
 * Generation is explicit and one-shot: read the staged index, ask the session's
 * own agent CLI (already authenticated by the user) for a message, and return a
 * draft. It never commits, stages, or writes to the working tree.
 */

import { isAgentHarness, harnessLabel, type HarnessId } from '../../shared/domain/harness'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { AiCommitMessageResult } from '../../shared/schemas/ai'
import { commitMessageArgs, shouldRetryCodexWithoutEphemeral } from './harness-args'
import {
  runHarnessOneShot,
  type OneShotResult,
  type OneShotRunOptions
} from './harness-one-shot'
import type { WslCommandRunner } from '../wsl/exec'
import { mainT } from '../i18n/main-i18n'
import { parseHarnessOutput } from './harness-output'
import {
  buildCommitPrompt,
  cleanGeneratedCommitMessage,
  excerptFailure,
  truncateDiffForPrompt
} from './commit-message-prompt'

export const COMMIT_MESSAGE_TIMEOUT_MS = 120_000

type SessionSummaryLike = { harness: HarnessId }

type GitRead =
  | { status: 'ok'; patch: string; truncated: boolean }
  | { status: 'unavailable'; detail: string }

export type CommitMessageDeps = {
  sessions: { get(sessionId: string): Promise<SessionSummaryLike> }
  gitWorkspace: {
    resolve(sessionId: string): Promise<
      | { status: 'ok'; worktreePath: string; target: ExecutionTarget }
      | { status: 'unavailable'; detail: string }
    >
    stagedDiff(sessionId: string): Promise<GitRead>
  }
  detectHarness: (
    harness: HarnessId,
    target: ExecutionTarget
  ) => Promise<HarnessDetectionResult>
  /** Test seam: the real implementation spawns the harness locally or in WSL. */
  runOneShot?: (options: OneShotRunOptions) => Promise<OneShotResult>
  /** Required for WSL worktrees; local sessions never use it. */
  wslRunner?: WslCommandRunner
}

type ActiveGeneration = {
  sessionId: string
  controller: AbortController
}

const unavailable = (
  reason: Extract<AiCommitMessageResult, { status: 'unavailable' }>['reason'],
  detail: string
): AiCommitMessageResult => ({ status: 'unavailable', reason, detail })

export class CommitMessageService {
  private readonly active = new Map<string, ActiveGeneration>()

  constructor(private readonly deps: CommitMessageDeps) {}

  /** Stops one generation by its renderer request id. */
  cancel(requestId: string): boolean {
    const active = this.active.get(requestId)
    if (active === undefined) return false
    active.controller.abort()
    this.active.delete(requestId)
    return true
  }

  async generate(sessionId: string, requestId: string): Promise<AiCommitMessageResult> {
    // One generation per session: a second click supersedes the first, even if
    // the renderer failed to send its cancel.
    for (const [id, active] of this.active) {
      if (active.sessionId === sessionId) {
        active.controller.abort()
        this.active.delete(id)
      }
    }

    let session: SessionSummaryLike
    try {
      session = await this.deps.sessions.get(sessionId)
    } catch (error) {
      return unavailable(
        'generation-failed',
        error instanceof Error ? error.message : mainT('scm.generation.sessionUnreadable')
      )
    }
    if (!isAgentHarness(session.harness)) {
      return unavailable(
        'not-agent',
        mainT('scm.generation.notAgent')
      )
    }
    const args = commitMessageArgs(session.harness)
    if (args === null) {
      return unavailable(
        'unsupported-harness',
        mainT('scm.generation.unsupportedHarness', {
          harness: harnessLabel(session.harness)
        })
      )
    }

    const resolved = await this.deps.gitWorkspace.resolve(sessionId)
    if (resolved.status !== 'ok') {
      return unavailable('generation-failed', resolved.detail)
    }
    const staged = await this.deps.gitWorkspace.stagedDiff(sessionId)
    if (staged.status !== 'ok') {
      return unavailable('generation-failed', staged.detail)
    }
    if (staged.patch.trim().length === 0) {
      return unavailable('no-staged-changes', mainT('scm.generation.stageFirst'))
    }

    let detection: HarnessDetectionResult
    try {
      detection = await this.deps.detectHarness(session.harness, resolved.target)
    } catch (error) {
      return unavailable(
        'harness-unavailable',
        error instanceof Error ? error.message : mainT('scm.generation.detectFailed')
      )
    }
    if (detection.state !== 'available' || detection.command === null) {
      const detail =
        detection.state === 'unavailable'
          ? detection.message
          : detection.state === 'detection_failed'
            ? detection.message
            : mainT('scm.generation.notAvailable')
      return unavailable('harness-unavailable', detail)
    }

    const budgeted = truncateDiffForPrompt(staged.patch)
    const prompt = buildCommitPrompt(budgeted.text, budgeted.truncated || staged.truncated)
    const controller = new AbortController()
    this.active.set(requestId, { sessionId, controller })
    const runOneShot =
      this.deps.runOneShot ??
      ((options: OneShotRunOptions) => runHarnessOneShot(options, this.deps.wslRunner))
    const label = harnessLabel(session.harness)

    try {
      let result = await runOneShot({
        detection,
        args,
        prompt,
        worktreePath: resolved.worktreePath,
        target: resolved.target,
        timeoutMs: COMMIT_MESSAGE_TIMEOUT_MS,
        signal: controller.signal
      })
      if (
        session.harness === 'codex' &&
        !result.cancelled &&
        result.exitCode !== 0 &&
        shouldRetryCodexWithoutEphemeral(result.stderr)
      ) {
        result = await runOneShot({
          detection,
          args: args.filter((arg) => arg !== '--ephemeral'),
          prompt,
          worktreePath: resolved.worktreePath,
          target: resolved.target,
          timeoutMs: COMMIT_MESSAGE_TIMEOUT_MS,
          signal: controller.signal
        })
      }

      if (result.cancelled || controller.signal.aborted) return { status: 'cancelled' }
      if (result.timedOut) {
        return unavailable(
          'generation-failed',
          `${label} timed out after ${String(Math.round(COMMIT_MESSAGE_TIMEOUT_MS / 1000))} seconds.`
        )
      }
      if (result.outputOverflow) {
        return unavailable('generation-failed', `${label} returned too much output.`)
      }
      if (result.exitCode !== 0) {
        const excerpt = excerptFailure(result.stdout, result.stderr)
        return unavailable(
          'generation-failed',
          `${label} failed${excerpt === null ? '.' : `: ${excerpt}`}`
        )
      }

      const parsed = parseHarnessOutput(session.harness, result.stdout)
      if (!parsed.ok) return unavailable('generation-failed', parsed.error)
      const message = cleanGeneratedCommitMessage(parsed.text)
      if (message.length === 0) {
        return unavailable(
          'generation-failed',
          mainT('scm.generation.emptyMessage', { harness: label })
        )
      }
      return { status: 'ok', message, agent: session.harness }
    } catch (error) {
      if (controller.signal.aborted) return { status: 'cancelled' }
      return unavailable(
        'generation-failed',
        error instanceof Error ? error.message : mainT('scm.generation.agentFailed')
      )
    } finally {
      const current = this.active.get(requestId)
      if (current?.controller === controller) this.active.delete(requestId)
    }
  }
}
