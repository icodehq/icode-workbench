import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActivityHookServer } from './hook-server'
import { ActivityService } from './activity-service'
import { buildClaudeSettings, HOOK_WRAPPER_NAME, installClaudeHooks } from './claude-hooks'
import { testSocketPath } from '../../host/test-platform'
import type { ActivityHookEvent } from '../../shared/domain/activity'

/**
 * These tests exercise the shipped hook script against a real `claude` binary.
 * They need no model access: an isolated CLAUDE_CONFIG_DIR is unauthenticated,
 * and the current CLI dispatches SessionStart and UserPromptSubmit before it
 * exits. The integration test asserts hook dispatch and the user's canary hook;
 * it does not depend on the model outcome.
 */

const roots: string[] = []
const SESSION = 'ses_0123456789abcdef0123456789abcdef'
const INC = 'abcdef1234567890'
let claudeAvailable = true
try {
  execFileSync('claude', ['--version'], { stdio: 'pipe' })
} catch {
  claudeAvailable = false
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'icode-activity-'))
  roots.push(root)
  return root
}

function hasClaude(): boolean {
  return claudeAvailable
}

/**
 * The probe must not inherit the developer's Claude authentication or session
 * markers. Without this, an authenticated shell can make the isolated config
 * reach a model and change the observed hook outcome.
 */
function isolatedClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE')) delete env[key]
  }
  return env
}

/**
 * Runs a command asynchronously. The activity server lives in this process, so a
 * blocking `spawnSync` would deadlock: the child connects while the parent's
 * event loop is frozen and cannot accept.
 */
function runAsync(
  command: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; elapsedMs: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 30_000)
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}${String(error)}`, elapsedMs: Date.now() - started, timedOut })
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr, elapsedMs: Date.now() - started, timedOut })
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

function socketPath(root: string): string {
  // POSIX keeps the socket beside the profile; Windows needs a named pipe.
  return testSocketPath(root, 'activity')
}

async function startIngress(root: string): Promise<{
  server: ActivityHookServer
  service: ActivityService
  events: ActivityHookEvent[]
  rejected: string[]
}> {
  const events: ActivityHookEvent[] = []
  const rejected: string[] = []
  const service = new ActivityService({
    isKnownSession: (sessionId) => sessionId === SESSION,
    currentIncarnation: (sessionId) => (sessionId === SESSION ? INC : null),
    onRejected: (reason) => rejected.push(reason)
  })
  const server = new ActivityHookServer({
    socketPath: socketPath(root),
    ingest: (event) => {
      events.push(event)
      return service.ingest(event)
    },
    onRejected: (reason) => rejected.push(reason)
  })
  await server.start()
  return { server, service, events, rejected }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe.runIf(hasClaude())('shipped hook script with real Claude', () => {
  // This spawns the real CLI (its own internal bound is 120 s), so the default
  // 5 s test timeout was never a truthful bound: under a loaded suite the child
  // alone takes longer. The assertions are unchanged.
  it('delivers hook events to the activity service and preserves a user canary hook', { timeout: 120_000 }, async () => {
    const root = tempRoot()
    const userConfig = join(root, 'user-config')
    const project = join(root, 'project')
    mkdirSync(userConfig, { recursive: true })
    mkdirSync(project, { recursive: true })

    const canary = join(root, 'canary.log')
    writeFileSync(
      join(userConfig, 'settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: `echo CANARY >> ${canary}` }] }
          ],
          Stop: [{ hooks: [{ type: 'command', command: `echo CANARY_STOP >> ${canary}` }] }],
          StopFailure: [
            { hooks: [{ type: 'command', command: `echo CANARY_STOPFAILURE >> ${canary}` }] }
          ]
        }
      })
    )

    const ingress = await startIngress(root)
    const hooks = installClaudeHooks({
      directory: join(root, 'agent-hooks'),
      execPath: process.execPath,
      electronRunAsNode: false
    })

    const result = await runAsync('claude', [...hooks.launchArgs, '-p', 'Reply with OK'], {
      cwd: project,
      timeoutMs: 120_000,
      env: {
        ...isolatedClaudeEnv(),
        CLAUDE_CONFIG_DIR: userConfig,
        ICODE_SESSION_ID: SESSION,
        ICODE_SESSION_INCARNATION: INC,
        ICODE_ACTIVITY_SOCKET: socketPath(root)
      }
    })
    // The isolated config is unauthenticated; that is expected and does not
    // prevent hook dispatch.
    expect(result.timedOut).toBe(false)

    // The isolated config cannot reach a model, so the CLI may exit before a
    // turn-end hook is emitted. The contract under test is hook dispatch and
    // the user's canary hook, not the model outcome.
    await new Promise((done) => setTimeout(done, 300))
    expect(ingress.events.length).toBeGreaterThan(0)
    expect(ingress.events.some((event) => event.event === 'SessionStart')).toBe(true)
    expect(ingress.events.some((event) => event.event === 'UserPromptSubmit')).toBe(true)

    // The user's own hook still ran under iCode's --settings overlay.
    const canaryText = readFileSync(canary, 'utf8')
    expect(canaryText).toContain('CANARY')

    // The overlay is additive and never touches the user's file.
    expect(readFileSync(join(userConfig, 'settings.json'), 'utf8')).toContain('CANARY')
    const overlay = JSON.parse(readFileSync(hooks.settingsPath, 'utf8')) as {
      hooks: Record<string, unknown>
    }
    expect(Object.keys(overlay.hooks)).toEqual(
      expect.arrayContaining(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop', 'StopFailure'])
    )
    expect(JSON.stringify(overlay)).not.toContain('Notification')
    await ingress.server.stop()
  })

  // Wall time includes Node startup, so a loaded CI machine can exceed the
  // in-script 100 ms deadline without any hook being slow. Retries re-measure
  // rather than hide a product failure: every attempt still has to deliver all
  // 50 events before this bound is applied.
  it('measures per-event hook delivery latency', { retry: 2 }, async () => {
    const root = tempRoot()
    const ingress = await startIngress(root)
    const hooks = installClaudeHooks({
      directory: join(root, 'agent-hooks'),
      execPath: process.execPath,
      electronRunAsNode: false
    })
    const durations: number[] = []
    const payload = JSON.stringify({
      session_id: 'claude-latency',
      prompt_id: 'prompt-latency',
      tool_name: 'Bash'
    })
    const invoke = async (): Promise<Awaited<ReturnType<typeof runAsync>>> =>
      runAsync(process.execPath, [hooks.scriptPath, 'PreToolUse'], {
        input: payload,
        timeoutMs: 5_000,
        env: {
          ...process.env,
          ICODE_SESSION_ID: SESSION,
          ICODE_SESSION_INCARNATION: INC,
          ICODE_ACTIVITY_SOCKET: socketPath(root)
        }
      })
    // Warm the interpreter and page cache so the measured runs are the hook,
    // not first-spawn disk I/O.
    for (let index = 0; index < 5; index += 1) await invoke()
    ingress.events.length = 0
    for (let index = 0; index < 50; index += 1) {
      const run = await invoke()
      durations.push(run.elapsedMs)
      expect(run.timedOut).toBe(false)
      expect(run.status).toBe(0)
      expect(run.stdout).toBe('')
    }
    await new Promise((done) => setTimeout(done, 300))
    durations.sort((left, right) => left - right)
    const p50 = durations[Math.floor(durations.length * 0.5)]!
    const p95 = durations[Math.floor(durations.length * 0.95)]!
    // eslint-disable-next-line no-console
    console.log(`[activity] hook latency p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`)
    // Report through the assertion message so CI logs carry the numbers.
    expect(ingress.events.length).toBe(50)
    // The contract's hard bound is the hook's 100 ms deadline.
    expect(p95, `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`).toBeLessThan(100)
    await ingress.server.stop()
  })

  it('exits 0 without writing stdout when iCode is unreachable', () => {
    const root = tempRoot()
    const hooks = installClaudeHooks({
      directory: join(root, 'agent-hooks'),
      execPath: process.execPath,
      electronRunAsNode: false
    })
    const run = spawnSync(process.execPath, [hooks.scriptPath, 'Stop'], {
      input: JSON.stringify({ session_id: 'claude-x' }),
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        ICODE_SESSION_ID: SESSION,
        ICODE_SESSION_INCARNATION: INC,
        ICODE_ACTIVITY_SOCKET: join(root, 'missing.sock')
      }
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
  })

  it('runs a packaged Electron binary as Node, and a plain node binary directly', () => {
    const packaged = JSON.parse(
      buildClaudeSettings('/opt/icode/icode', '/tmp/hook.cjs', true)
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(packaged.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(
      "env ELECTRON_RUN_AS_NODE=1 '/opt/icode/icode' '/tmp/hook.cjs' 'UserPromptSubmit'"
    )
    // Claude abandons StopFailure hooks on its way out, so packaged turn-end
    // hooks detach while keeping the payload on fd 3.
    expect(packaged.hooks.StopFailure?.[0]?.hooks[0]?.command).toBe(
      "sh -c 'exec 3<&0; (setsid env ELECTRON_RUN_AS_NODE=1 '\\''/opt/icode/icode'\\'' '\\''/tmp/hook.cjs'\\'' '\\''StopFailure'\\'' <&3) >/dev/null 2>&1 &'"
    )
    const plain = JSON.parse(
      buildClaudeSettings('/usr/bin/node', '/tmp/hook.cjs', false)
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(plain.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(
      "'/usr/bin/node' '/tmp/hook.cjs' 'UserPromptSubmit'"
    )
    expect(plain.hooks.StopFailure?.[0]?.hooks[0]?.command).toBe(
      "'/usr/bin/node' '/tmp/hook.cjs' 'StopFailure'"
    )
  })

  it('uses platform-appropriate lifecycle commands', () => {
    type Settings = { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const mac = JSON.parse(
      buildClaudeSettings('/Applications/iCode.app/Contents/MacOS/iCode', '/tmp/hook.cjs', true, 'darwin')
    ) as Settings
    expect(mac.hooks.StopFailure?.[0]?.hooks[0]?.command).toContain('nohup')
    expect(mac.hooks.StopFailure?.[0]?.hooks[0]?.command).not.toContain('setsid')

    // The wrapper is derived from the script path with the host's path
    // semantics; this test runs on Linux and only asserts the command shape.
    const scriptPath = '/hooks/icode-activity-hook.cjs'
    const wrapper = join(dirname(scriptPath), HOOK_WRAPPER_NAME)
    const win = JSON.parse(
      buildClaudeSettings('C:\\iCode\\iCode.exe', scriptPath, true, 'win32')
    ) as Settings
    expect(win.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(
      `"${wrapper}" "UserPromptSubmit"`
    )
    expect(win.hooks.StopFailure?.[0]?.hooks[0]?.command).toBe(
      `"${wrapper}" "StopFailure"`
    )
  })

  it('writes a cmd wrapper on Windows', () => {
    const root = tempRoot()
    const hooks = installClaudeHooks({
      directory: join(root, 'agent-hooks'),
      execPath: 'C:\\iCode\\iCode.exe',
      electronRunAsNode: true,
      platform: 'win32'
    })
    const wrapper = readFileSync(join(dirname(hooks.scriptPath), HOOK_WRAPPER_NAME), 'utf8')
    expect(wrapper).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(wrapper).toContain('"C:\\iCode\\iCode.exe"')
    const settings = JSON.parse(readFileSync(hooks.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toContain('icode-activity-hook.cmd')
  })

})

describe('shipped hook script transport', () => {
  it('delivers one event over the real ingress and exits 0', async () => {
    const root = tempRoot()
    const ingress = await startIngress(root)
    const hooks = installClaudeHooks({
      directory: join(root, 'agent-hooks'),
      execPath: process.execPath,
      electronRunAsNode: false
    })
    const run = await runAsync(process.execPath, [hooks.scriptPath, 'Stop'], {
      input: JSON.stringify({ session_id: 'claude-delivery' }),
      timeoutMs: 5_000,
      env: {
        ...process.env,
        ICODE_SESSION_ID: SESSION,
        ICODE_SESSION_INCARNATION: INC,
        ICODE_ACTIVITY_SOCKET: socketPath(root)
      }
    })
    expect(run.timedOut).toBe(false)
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(ingress.events.map((event) => event.event)).toContain('Stop')
    expect(ingress.rejected).toEqual([])
    await ingress.server.stop()
  })

  it('never lingers when the socket accepts but never replies', async () => {
    const root = tempRoot()
    const hooks = installClaudeHooks({
      directory: join(root, 'agent-hooks'),
      execPath: process.execPath,
      electronRunAsNode: false
    })
    const path = socketPath(root)
    // A named pipe needs no directory; the POSIX socket's parent does.
    if (!path.startsWith('\\\\')) mkdirSync(dirname(path), { recursive: true })
    const server = (await import('node:net')).createServer((socket) => {
      // Accept and hold the connection without a reply.
      socket.on('data', () => undefined)
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    const run = await runAsync(process.execPath, [hooks.scriptPath, 'UserPromptSubmit'], {
      input: JSON.stringify({ session_id: 'claude-y' }),
      timeoutMs: 5_000,
      env: {
        ...process.env,
        ICODE_SESSION_ID: SESSION,
        ICODE_SESSION_INCARNATION: INC,
        ICODE_ACTIVITY_SOCKET: path
      }
    })
    expect(run.timedOut).toBe(false)
    expect(run.status).toBe(0)
    // The one-second transport guard must win well before the 5 s hard timeout;
    // the bound leaves room for a cold Node start on a loaded Windows runner.
    expect(run.elapsedMs).toBeLessThan(3_000)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

describe.skipIf(hasClaude())('hook integration (claude missing)', () => {
  it('is skipped without a claude binary', () => {
    expect(existsSync('/nonexistent')).toBe(false)
  })
})
