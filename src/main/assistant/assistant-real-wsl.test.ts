import { describe, expect, it } from 'vitest'
import { runHarnessOneShot } from '../ai/harness-one-shot'
import { discoverWslDistros, isInternalDistro } from '../wsl/distros'
import { WslCommandRunner } from '../wsl/exec'
import {
  createGuestHarnessDetector,
  withGuestLaunchCommand
} from '../wsl/harness/guest-harness-detector'
import { parseAssistantEnvelope } from './assistant-envelope'
import { assistantHarnessArgs, parseAssistantHarnessOutput } from './assistant-harness'
import { ClaudeStreamParser } from './assistant-stream'

const real = process.env.ICODE_ASSISTANT_REAL === '1' && process.platform === 'win32'

describe.skipIf(!real)('Mira with real WSL Claude', () => {
  it('detects and runs Claude inside a WSL distro', async () => {
    const runner = new WslCommandRunner()
    const discovery = await discoverWslDistros({ runner })
    if (discovery.status !== 'ok') {
      throw new Error(`WSL discovery failed: ${discovery.reason}`)
    }
    const configured = process.env.ICODE_TEST_WSL_DISTRO
    const distro =
      configured ??
      discovery.distros.find((entry) => !isInternalDistro(entry.name))?.name
    expect(distro, 'no non-internal WSL distro found').toBeTruthy()

    const { detector, context } = await createGuestHarnessDetector({
      runner,
      distro: distro!
    })
    const raw = await detector.detectOne('claude')
    if (raw.state !== 'available') {
      throw new Error(`Claude is not available in ${distro!}: ${JSON.stringify(raw)}`)
    }
    const detection = withGuestLaunchCommand(raw, { shell: context.shell })
    if (detection.state !== 'available') {
      throw new Error(`Claude launch command is unavailable in ${distro!}`)
    }

    const parser = new ClaudeStreamParser()
    const chunks: string[] = []
    const result = await runHarnessOneShot(
      {
        detection,
        args: assistantHarnessArgs('claude')!,
        prompt:
          'Remember the codeword WSL_ORCHID. Return exactly this JSON and nothing else: {"reply":"WSL_PROBE_OK","actions":[]}',
        worktreePath: '/tmp',
        target: { kind: 'wsl', distro: distro!, distroId: null },
        timeoutMs: 120_000,
        signal: new AbortController().signal,
        onStdoutChunk: (chunk) => {
          chunks.push(chunk)
          parser.push(chunk)
        }
      },
      runner
    )

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(chunks.length).toBeGreaterThan(0)
    expect(parser.finish().draft).toContain('WSL_PROBE_OK')
    const parsed = parseAssistantHarnessOutput('claude', result.stdout)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const envelope = parseAssistantEnvelope(parsed.text)
    expect(envelope.ok).toBe(true)
    if (envelope.ok) expect(envelope.value.reply).toContain('WSL_PROBE_OK')

    const sessionId = /"session_id":"([^"]+)"/u.exec(result.stdout)?.[1]
    expect(sessionId, 'Claude did not report a session id').toBeTruthy()
    if (!sessionId) return

    const resumedParser = new ClaudeStreamParser()
    const resumed = await runHarnessOneShot(
      {
        detection,
        args: [...assistantHarnessArgs('claude')!, '--resume', sessionId],
        prompt:
          'What codeword did I ask you to remember? Return exactly this JSON and nothing else: {"reply":"<the codeword>","actions":[]}',
        worktreePath: '/tmp',
        target: { kind: 'wsl', distro: distro!, distroId: null },
        timeoutMs: 120_000,
        signal: new AbortController().signal,
        onStdoutChunk: (chunk) => resumedParser.push(chunk)
      },
      runner
    )
    expect(resumed.exitCode).toBe(0)
    const resumedParsed = parseAssistantHarnessOutput('claude', resumed.stdout)
    expect(resumedParsed.ok).toBe(true)
    if (!resumedParsed.ok) return
    const resumedEnvelope = parseAssistantEnvelope(resumedParsed.text)
    expect(resumedEnvelope.ok).toBe(true)
    if (resumedEnvelope.ok) expect(resumedEnvelope.value.reply).toContain('WSL_ORCHID')
  }, 180_000)

  it('kills a hanging guest harness when the turn times out', async () => {
    const runner = new WslCommandRunner()
    const discovery = await discoverWslDistros({ runner })
    if (discovery.status !== 'ok') throw new Error(`WSL discovery failed: ${discovery.reason}`)
    const distro =
      process.env.ICODE_TEST_WSL_DISTRO ??
      discovery.distros.find((entry) => !isInternalDistro(entry.name))?.name
    expect(distro).toBeTruthy()
    const started = Date.now()
    const result = await runHarnessOneShot(
      {
        detection: {
          state: 'available',
          harness: 'claude',
          version: 'test',
          resolvedPath: '/bin/sh',
          command: {
            command: '/bin/sh',
            args: ['-ilc', 'exec sleep 300'],
            shellWrapper: { scriptIndex: 1 }
          },
          diagnostics: {}
        } as never,
        args: [],
        prompt: 'x',
        worktreePath: '/tmp',
        target: { kind: 'wsl', distro: distro!, distroId: null },
        timeoutMs: 300,
        signal: new AbortController().signal,
        onStdoutChunk: () => undefined
      },
      runner
    )
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 30_000)
})
