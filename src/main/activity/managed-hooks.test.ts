import { createServer, type Server } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MANAGED_HOOK_WRAPPER_NAME,
  ensureManagedHookScript,
  installManagedHooksForProvider,
  managedHooksStatus,
  removeManagedHooksForProvider,
  type ManagedHookInstallOptions,
  type ManagedHookProvider
} from './managed-hooks'

const roots: string[] = []

function root(): { home: string; directory: string; options: ManagedHookInstallOptions } {
  const base = mkdtempSync(join(tmpdir(), 'icode-managed-hooks-'))
  roots.push(base)
  const home = join(base, 'home')
  const directory = join(base, 'agent-hooks')
  mkdirSync(home, { recursive: true })
  return {
    home,
    directory,
    options: {
      home,
      directory,
      execPath: process.execPath,
      electronRunAsNode: false
    }
  }
}

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

function geminiConfig(home: string, value: unknown): string {
  const path = join(home, '.gemini', 'settings.json')
  mkdirSync(join(home, '.gemini'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

function qwenConfig(home: string, value: unknown): string {
  const path = join(home, '.qwen', 'settings.json')
  mkdirSync(join(home, '.qwen'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

function cursorConfig(home: string, value: unknown): string {
  const path = join(home, '.cursor', 'hooks.json')
  mkdirSync(join(home, '.cursor'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function definitions(config: Record<string, unknown>, event: string): Array<Record<string, unknown>> {
  const hooks = config.hooks as Record<string, unknown>
  return hooks[event] as Array<Record<string, unknown>>
}

describe('managed hook config ownership', () => {
  it('adds Gemini hooks and preserves user hooks and unrelated keys', () => {
    const { home, options } = root()
    const config = geminiConfig(home, {
      theme: 'dark',
      hooks: {
        BeforeAgent: [{ hooks: [{ type: 'command', command: 'user-before' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keep-me' }] }]
      }
    })

    expect(installManagedHooksForProvider('gemini', options).state).toBe('installed')
    const afterInstall = read(config)
    expect(afterInstall.theme).toBe('dark')
    expect(definitions(afterInstall, 'UserPromptSubmit')).toEqual([
      { hooks: [{ type: 'command', command: 'keep-me' }] }
    ])
    const before = definitions(afterInstall, 'BeforeAgent')
    expect(before[0]).toEqual({ hooks: [{ type: 'command', command: 'user-before' }] })
    expect(before).toHaveLength(2)
    expect(before[1]).toMatchObject({
      hooks: [
        {
          command: expect.stringContaining('icode-managed-hook'),
          type: 'command',
          timeout: 10_000
        }
      ]
    })

    // Reinstall is idempotent.
    expect(installManagedHooksForProvider('gemini', options).state).toBe('installed')
    expect(definitions(read(config), 'BeforeAgent')).toHaveLength(2)

    expect(removeManagedHooksForProvider('gemini', options).state).toBe('not-installed')
    const afterRemove = read(config)
    expect(afterRemove).toEqual({
      theme: 'dark',
      hooks: {
        BeforeAgent: [{ hooks: [{ type: 'command', command: 'user-before' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keep-me' }] }]
      }
    })
  })

  it('does not drop unrelated user definitions with no commands', () => {
    const { home, options } = root()
    const config = geminiConfig(home, {
      hooks: {
        BeforeAgent: [{ matcher: '*' }]
      }
    })
    installManagedHooksForProvider('gemini', options)
    expect(definitions(read(config), 'BeforeAgent')[0]).toEqual({ matcher: '*' })
  })

  it('installs the Claude-shaped Qwen settings and removes only managed entries', () => {
    const { home, options } = root()
    const config = qwenConfig(home, {
      model: 'qwen3',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }] }
    })
    expect(installManagedHooksForProvider('qwen-code', options).state).toBe('installed')
    const installed = read(config)
    expect(installed.model).toBe('qwen3')
    expect(definitions(installed, 'Stop')).toHaveLength(2)
    expect(definitions(installed, 'PermissionRequest')).toHaveLength(1)

    removeManagedHooksForProvider('qwen-code', options)
    expect(read(config)).toEqual({
      model: 'qwen3',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }] }
    })
  })

  it('adds Cursor version and direct command definitions', () => {
    const { home, options } = root()
    const config = cursorConfig(home, {
      hooks: { stop: [{ command: 'user-stop' }] }
    })
    expect(installManagedHooksForProvider('cursor', options).state).toBe('installed')
    const installed = read(config)
    expect(installed.version).toBe(1)
    const stop = definitions(installed, 'stop')
    expect(stop[0]).toEqual({ command: 'user-stop' })
    expect(stop[1]).toMatchObject({
      command: expect.stringContaining('icode-managed-hook'),
      timeout: 10
    })
    expect(definitions(installed, 'beforeSubmitPrompt')).toHaveLength(1)

    removeManagedHooksForProvider('cursor', options)
    expect(read(config)).toEqual({
      version: 1,
      hooks: { stop: [{ command: 'user-stop' }] }
    })
  })

  it('writes Copilot to its own hooks file and never clears disableAllHooks', () => {
    const { home, options } = root()
    const env = { ...process.env, COPILOT_HOME: join(home, 'copilot-home') }
    const config = join(env.COPILOT_HOME, 'hooks', 'icode.json')
    mkdirSync(join(env.COPILOT_HOME, 'hooks'), { recursive: true })
    writeFileSync(config, JSON.stringify({ version: 1, disableAllHooks: true }))
    const withEnv = { ...options, env }

    const status = installManagedHooksForProvider('copilot', withEnv)
    expect(status.state).toBe('not-installed')
    expect(read(config)).toEqual({ version: 1, disableAllHooks: true })

    writeFileSync(config, JSON.stringify({ version: 1 }))
    expect(installManagedHooksForProvider('copilot', withEnv).state).toBe('installed')
    const installed = read(config)
    expect(definitions(installed, 'UserPromptSubmit')[0]).toMatchObject({
      type: 'command',
      bash: expect.stringContaining('icode-managed-hook'),
      powershell: expect.stringContaining('icode-managed-hook'),
      timeoutSec: 5
    })
    removeManagedHooksForProvider('copilot', withEnv)
    expect(read(config)).toEqual({ version: 1, hooks: {} })
  })

  it('refuses an event whose hook value is not an array', () => {
    const { home, options } = root()
    const config = geminiConfig(home, { hooks: { BeforeAgent: 'user-owned' } })
    const status = installManagedHooksForProvider('gemini', options)
    expect(status.state).toBe('failed')
    expect(read(config)).toEqual({ hooks: { BeforeAgent: 'user-owned' } })
  })

  it('refuses to rewrite invalid JSON', () => {
    const { home, options } = root()
    const config = geminiConfig(home, { hooks: {} })
    writeFileSync(config, '{not json')
    const status = installManagedHooksForProvider('gemini', options)
    expect(status.state).toBe('failed')
    expect(readFileSync(config, 'utf8')).toBe('{not json')
    expect(managedHooksStatus('gemini', options).state).toBe('failed')
  })

  it('emits a Windows wrapper command with the provider event and response code', () => {
    const { directory, home } = root()
    const runtime = ensureManagedHookScript({
      directory,
      home,
      execPath: 'C:\\Program Files\\iCode\\icode.exe',
      electronRunAsNode: true,
      platform: 'win32',
      env: {}
    })
    const command = runtime.commandFor('gemini', {
      providerEvent: 'BeforeAgent',
      canonicalEvent: 'UserPromptSubmit',
      response: 'json'
    })
    expect(command).toContain(MANAGED_HOOK_WRAPPER_NAME)
    expect(command).toContain('gemini BeforeAgent UserPromptSubmit json')
    expect(readFileSync(runtime.wrapperPath!, 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1')
  })
})

describe('managed hook script', () => {
  let server: Server | null = null

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
  })

  async function receive(
    provider: ManagedHookProvider,
    providerEvent: string,
    canonicalEvent: string,
    response: string,
    payload: unknown,
    expectedStdout: string,
    options: { stdinText?: string; env?: Record<string, string> } = {}
  ): Promise<Record<string, unknown>> {
    const { directory, home } = root()
    const runtime = ensureManagedHookScript({
      directory,
      home,
      execPath: process.execPath,
      electronRunAsNode: false,
      env: {}
    })
    const socket =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\icode-managed-hook-test-${String(process.pid)}-${String(Date.now())}`
        : join(directory, 'activity.sock')
    const received = new Promise<Record<string, unknown>>((resolve) => {
      server = createServer((connection) => {
        const chunks: Buffer[] = []
        connection.on('data', (chunk) => chunks.push(chunk))
        connection.on('end', () => {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        })
      })
    })
    await new Promise<void>((resolve) => server!.listen(socket, resolve))

    const { spawn } = await import('node:child_process')
    const child = spawn(
      process.execPath,
      [runtime.scriptPath, provider, providerEvent, canonicalEvent, response],
      {
        env: {
          ...process.env,
          ICODE_ACTIVITY_SOCKET: socket,
          ICODE_SESSION_ID: 'ses_1',
          ICODE_SESSION_INCARNATION: 'inc_1',
          ...options.env
        }
      }
    )
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stdin.end(options.stdinText ?? JSON.stringify(payload))
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    expect(code).toBe(0)
    expect(stdout).toBe(expectedStdout)
    const result = await received
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    return result
  }

  it('normalizes Gemini payload fields and answers {}', async () => {
    const payload = await receive(
      'gemini',
      'BeforeAgent',
      'UserPromptSubmit',
      'json',
      { session_id: 'gemini-1', prompt_id: 'p1', tool_name: 'Bash' },
      '{}\n'
    )
    expect(payload).toMatchObject({
      event: 'UserPromptSubmit',
      sessionId: 'ses_1',
      incarnationId: 'inc_1',
      claudeSessionId: 'gemini-1',
      promptId: 'p1',
      toolName: 'Bash'
    })
  })

  it('normalizes Cursor conversation ids and answers continue', async () => {
    const payload = await receive(
      'cursor',
      'beforeSubmitPrompt',
      'UserPromptSubmit',
      'continue',
      { conversation_id: 'cursor-1', tool_name: 'Read' },
      '{"continue":true}\n'
    )
    expect(payload).toMatchObject({
      event: 'UserPromptSubmit',
      claudeSessionId: 'cursor-1',
      toolName: 'Read'
    })
  })

  it('maps an interrupted Cursor stop to StopFailure', async () => {
    const payload = await receive(
      'cursor',
      'stop',
      'Stop',
      'json',
      { conversation_id: 'cursor-1', status: 'cancelled' },
      '{}\n'
    )
    expect(payload).toMatchObject({ event: 'StopFailure', claudeSessionId: 'cursor-1' })
  })

  it('answers ask for Antigravity PreToolUse and the empty decision for Stop', async () => {
    const preTool = await receive(
      'antigravity',
      'PreToolUse',
      'PreToolUse',
      'ask',
      { conversation_id: 'agy-1', tool_name: 'run_command' },
      '{"decision":"ask"}\n'
    )
    expect(preTool).toMatchObject({
      event: 'PreToolUse',
      claudeSessionId: 'agy-1',
      toolName: 'run_command'
    })
    const stop = await receive(
      'antigravity',
      'Stop',
      'Stop',
      'stop',
      { conversation_id: 'agy-1', fullyIdle: true },
      '{"decision":""}\n'
    )
    expect(stop).toMatchObject({ event: 'Stop', claudeSessionId: 'agy-1' })
  })

  it('holds Antigravity Stop open while helpers are still running', async () => {
    const payload = await receive(
      'antigravity',
      'Stop',
      'Stop',
      'stop',
      { conversation_id: 'agy-1', fullyIdle: false },
      '{"decision":""}\n'
    )
    expect(payload).toMatchObject({ event: 'PostToolUse' })
  })

  it('maps Devin is_interrupt and JCode error turns to StopFailure', async () => {
    const devin = await receive(
      'devin',
      'Stop',
      'Stop',
      'json',
      { session_id: 'devin-1', is_interrupt: true },
      '{}\n'
    )
    expect(devin).toMatchObject({ event: 'StopFailure', claudeSessionId: 'devin-1' })
    const jcode = await receive(
      'jcode',
      'turn_end',
      'Stop',
      'none',
      {},
      '',
      {
        stdinText: '',
        env: {
          JCODE_HOOK_PAYLOAD: JSON.stringify({ session_id: 'jcode-1', status: 'error' }),
          JCODE_HOOK_SESSION_ID: 'jcode-1'
        }
      }
    )
    expect(jcode).toMatchObject({ event: 'StopFailure', claudeSessionId: 'jcode-1' })
  })

  it('posts the JCode environment payload without stdin', async () => {
    const payload = await receive(
      'jcode',
      'pre_tool',
      'PreToolUse',
      'none',
      {},
      '',
      {
        stdinText: '',
        env: {
          JCODE_HOOK_PAYLOAD: JSON.stringify({ session_id: 'jcode-2', tool_name: 'Bash' }),
          JCODE_HOOK_SESSION_ID: 'jcode-2'
        }
      }
    )
    expect(payload).toMatchObject({
      event: 'PreToolUse',
      claudeSessionId: 'jcode-2',
      toolName: 'Bash'
    })
  })

  it('answers nothing for Qwen and accepts camelCase fields', async () => {
    const payload = await receive(
      'qwen-code',
      'PreToolUse',
      'PreToolUse',
      'none',
      { sessionId: 'qwen-1', turnId: 't1', toolName: 'Edit' },
      ''
    )
    expect(payload).toMatchObject({
      event: 'PreToolUse',
      claudeSessionId: 'qwen-1',
      promptId: 't1',
      toolName: 'Edit'
    })
  })

  it('reads a nested Copilot tool object', async () => {
    const payload = await receive(
      'copilot',
      'PreToolUse',
      'PreToolUse',
      'json',
      { session_id: 'copilot-1', tool: { name: 'bash' } },
      '{}\n'
    )
    expect(payload).toMatchObject({ claudeSessionId: 'copilot-1', toolName: 'bash' })
  })
})
