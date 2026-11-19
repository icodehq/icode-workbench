import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type {
  ProviderProtocol,
  ProviderRecipeHarness
} from '../../shared/domain/provider-recipes'
import {
  PROVIDER_RECIPE_HARNESSES,
  PROVIDER_RECIPES
} from '../../shared/domain/provider-recipes'
import { harnessDefinition } from '../../shared/domain/harness'
import { LOCAL_EXECUTION_TARGET } from '../../shared/domain/repository'
import { makeTempRoot, type TempRoot } from '../persistence/persistence-test-fixtures'
import { materializeProviderLaunch } from './provider-materializer'

/**
 * Hands-on recipe verification.
 *
 * Disabled by default. Set `ICODE_PROVIDER_LIVE=1` on a machine with the CLI
 * installed, run `pnpm verify:providers`, and each recipe below spawns its
 * CLI against the local mock endpoint. A recipe with no invocation is left for
 * a manual check (unknown one-shot flag, or a CLI that needs a git repo).
 */

const LIVE = process.env.ICODE_PROVIDER_LIVE === '1'
const MOCK_SCRIPT = fileURLToPath(
  new URL('../../../tests/verification/providers/mock-server.cjs', import.meta.url)
)

type Invocation = {
  promptArgs: string[]
  /** Some CLIs need more than `--version`; keep the default otherwise. */
  versionArgs?: string[]
}

const INVOCATIONS: Partial<Record<ProviderRecipeHarness, Invocation>> = {
  openclaude: { promptArgs: ['-p', 'hello'] },
  'qwen-code': { promptArgs: ['-p', 'hello'] },
  gemini: { promptArgs: ['-p', 'hello'] },
  copilot: { promptArgs: ['-p', 'hello'] },
  goose: { promptArgs: ['run', '-t', 'hello'] },
  continue: { promptArgs: ['-p', 'hello'] },
  kilo: { promptArgs: ['run', 'hello'] },
  pi: { promptArgs: ['-p', 'hello'] },
  omp: { promptArgs: ['-p', 'hello'] },
  'mistral-vibe': { promptArgs: ['-p', 'hello'] }
}

type Recorded = {
  path: string
  search: string
  headers: Record<string, string>
  body: string
}

function waitForLine(child: ChildProcess, prefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      reject(new Error(`mock server did not print ${prefix}`))
    }, 10_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const line = buffer
        .split(/\r?\n/u)
        .find((entry) => entry.startsWith(prefix))
      if (line !== undefined) {
        clearTimeout(timer)
        resolve(line.slice(prefix.length).trim())
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function readRequests(baseUrl: string): Promise<Recorded[]> {
  const response = await fetch(`${baseUrl}/__requests`)
  const payload = (await response.json()) as { requests: Recorded[] }
  return payload.requests
}

function expectedPath(protocol: ProviderProtocol): string {
  switch (protocol) {
    case 'anthropic':
      return '/v1/messages'
    case 'openai-chat':
      return '/v1/chat/completions'
    case 'openai-responses':
      return '/v1/responses'
    case 'google-genai':
      return ':generateContent'
  }
}

describe.runIf(LIVE)('live provider verification', () => {
  let server: ChildProcess | null = null
  let baseUrl = ''
  const roots: TempRoot[] = []

  beforeAll(async () => {
    server = spawn(process.execPath, [MOCK_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const port = await waitForLine(server, 'LISTENING')
    baseUrl = `http://127.0.0.1:${port}`
  }, 20_000)

  afterAll(() => {
    server?.kill('SIGTERM')
    for (const root of roots) root.cleanup()
  })

  for (const harness of PROVIDER_RECIPE_HARNESSES) {
    const invocation = INVOCATIONS[harness]
    if (invocation === undefined) continue

    it(`${harness} reaches the configured endpoint`, async () => {
      const root = makeTempRoot('icode-provider-live-')
      roots.push(root)
      const recipe = PROVIDER_RECIPES[harness]
      const provider = {
        id: `prv_live_${harness}`,
        harness,
        baseUrl,
        model: 'test-model',
        authStyle: recipe.authStyles[0] ?? null,
        apiKey: 'sk-live-test'
      }
      const materialized = materializeProviderLaunch({
        userDataDir: root.dir,
        homeDir: root.dir,
        provider,
        target: LOCAL_EXECUTION_TARGET,
        env: {}
      })

      const definition = harnessDefinition(harness)
      if (definition.command.kind !== 'executable') {
        throw new Error(`${harness} has no executable`)
      }
      const command = definition.command.name
      const child = spawn(
        command,
        [...materialized.args, ...invocation.promptArgs],
        {
          cwd: root.dir,
          env: { ...process.env, ...materialized.env },
          stdio: ['ignore', 'ignore', 'pipe'],
          shell: process.platform === 'win32'
        }
      )
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8').slice(0, 2000)
      })

      try {
        await fetch(`${baseUrl}/__reset`)
        const wanted = expectedPath(recipe.protocol)
        const deadline = Date.now() + 30_000
        let recorded: Recorded | undefined
        while (Date.now() < deadline) {
          const requests = await readRequests(baseUrl)
          recorded = requests.find((entry) => entry.path.includes(wanted))
          if (recorded !== undefined) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        expect(
          recorded,
          `${harness} sent no request to ${wanted}; stderr: ${stderr}`
        ).toBeDefined()
        if (recorded === undefined) return

        if (recipe.protocol === 'google-genai') {
          expect(recorded.headers['x-goog-api-key']).toBe('sk-live-test')
          expect(recorded.path).toContain('test-model')
        } else {
          expect(recorded.headers.authorization).toContain('Bearer sk-live-test')
          expect(recorded.body).toContain('test-model')
        }

        let version = 'unknown'
        try {
          version = execFileSync(command, invocation.versionArgs ?? ['--version'], {
            encoding: 'utf8',
            timeout: 10_000
          })
            .trim()
            .split(/\r?\n/u)[0]!
        } catch {
          // A missing version flag does not invalidate a real request.
        }
        console.log(`[provider-live] ${harness}: ${version}`)
      } finally {
        child.kill()
        // Give the child a moment to release the mock connection.
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }, 60_000)
  }
})
