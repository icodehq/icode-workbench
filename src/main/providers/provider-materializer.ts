import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  PROVIDER_RECIPES,
  providerLaunchPlan,
  type ProviderFileFormat,
  type ProviderLaunchInput,
  type ProviderLaunchPlan,
  type ProviderSeedSource,
  type ProviderSeedSpec
} from '../../shared/domain/provider-recipes'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { writeTextAtomic } from '../activity/managed-hooks-text'
import { toGuestVisiblePath } from '../wsl/guest-visible-path'

/**
 * Turns a provider recipe's declarative delivery into files on disk and the
 * args/env a session needs.
 *
 * Layout under `<userData>/provider-runtime/<providerId>/`:
 *
 *   <sha16>/<relativePath>   file delivery, content-addressed per launch
 *   home/                    stable directory delivery
 *
 * File deliveries are content-addressed so a provider switch never rewrites the
 * file a running session already opened. Directory deliveries are stable
 * because the harness writes session state into its config home; the generated
 * `.icode-generated` marker is what permits deleting that home later.
 */

const RUNTIME_DIRECTORY = 'provider-runtime'
const GENERATED_MARKER = '.icode-generated'
const DEFAULT_MAX_AGE_MS = 72 * 60 * 60 * 1000

export class ProviderDeliveryPathError extends Error {
  constructor(readonly path: string) {
    super(
      `The provider's generated files are under a path WSL cannot open (${path}). ` +
        'Move iCode data to a local drive or use a local repository.'
    )
    this.name = 'ProviderDeliveryPathError'
  }
}

export type MaterializableProvider = ProviderLaunchInput & { id: string }

export type ProviderMaterializeResult = {
  args: string[]
  env: Record<string, string>
}

function sha16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function safeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/gu, '/')
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Invalid generated provider path: ${relativePath}`)
  }
  return relativePath
}

function providerRoot(userDataDir: string, providerId: string): string {
  return join(userDataDir, RUNTIME_DIRECTORY, providerId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Generated entries win; untouched user entries survive. */
function mergeValue(base: unknown, generated: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(generated)) {
    const result = [...base]
    for (const item of generated) {
      const id = isRecord(item) ? (item.id ?? item.name) : undefined
      const index =
        typeof id === 'string'
          ? result.findIndex(
              (value) => isRecord(value) && (value.id ?? value.name) === id
            )
          : -1
      if (index >= 0) {
        result[index] = item
      } else if (
        !result.some((value) => JSON.stringify(value) === JSON.stringify(item))
      ) {
        result.push(item)
      }
    }
    return result
  }
  if (isRecord(base) && isRecord(generated)) {
    const result: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(generated)) {
      result[key] = key in base ? mergeValue(base[key], value) : value
    }
    return result
  }
  return generated
}

function mergeJsonText(seed: string, generated: string): string {
  try {
    const base = parseJsonc(seed) as unknown
    const next = JSON.parse(generated) as unknown
    return `${JSON.stringify(mergeValue(base, next), null, 2)}\n`
  } catch {
    return generated
  }
}

function mergeYamlText(seed: string, generated: string): string {
  try {
    const base = parseYaml(seed) as unknown
    const next = parseYaml(generated) as unknown
    return stringifyYaml(mergeValue(base, next))
  } catch {
    return generated
  }
}

function mergeTomlText(seed: string, generated: string): string {
  // Our own provider block replaces an earlier one; otherwise preserve every
  // other table and append ours, dropping a duplicate active_model.
  if (/^name\s*=\s*"icode"\s*$/mu.test(seed)) return generated
  const withoutActive = seed.replace(/^active_model\s*=.*$/gmu, '').trimEnd()
  return withoutActive.length === 0 ? generated : `${withoutActive}\n\n${generated}`
}

function formatForPath(relativePath: string): ProviderFileFormat {
  if (/\.jsonc$/iu.test(relativePath)) return 'jsonc'
  if (/\.json$/iu.test(relativePath)) return 'json'
  if (/\.ya?ml$/iu.test(relativePath)) return 'yaml'
  if (/\.toml$/iu.test(relativePath)) return 'toml'
  return 'text'
}

function mergeSeedText(
  seed: string,
  generated: string,
  format: ProviderFileFormat
): string {
  switch (format) {
    case 'json':
    case 'jsonc':
      return mergeJsonText(seed, generated)
    case 'yaml':
      return mergeYamlText(seed, generated)
    case 'toml':
      return mergeTomlText(seed, generated)
    case 'text':
      return generated
  }
}

function resolveSeedSource(
  source: ProviderSeedSource | undefined,
  homeDir: string,
  env: NodeJS.ProcessEnv
): string | null {
  if (source === undefined) return null
  if (source.env !== undefined) {
    const value = env[source.env]
    if (value !== undefined && value.length > 0) {
      const candidate =
        source.envSegments === undefined
          ? value
          : join(value, ...source.envSegments)
      if (existsSync(candidate)) return candidate
    }
  }
  for (const segments of source.homePaths ?? []) {
    const candidate = join(homeDir, ...segments)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function readSeedText(
  seed: ProviderSeedSpec | undefined,
  homeDir: string,
  env: NodeJS.ProcessEnv
): string | null {
  const source = resolveSeedSource(seed, homeDir, env)
  if (source === null) return null
  try {
    return readFileSync(source, 'utf8')
  } catch {
    return null
  }
}

function copySeedFiles(
  seed: ProviderSeedSpec,
  home: string,
  homeDir: string,
  env: NodeJS.ProcessEnv
): void {
  for (const entry of seed.copy ?? []) {
    const source = resolveSeedSource(entry, homeDir, env)
    if (source === null) continue
    try {
      const target = join(home, safeRelativePath(entry.target))
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      copyFileSync(source, target)
    } catch {
      // Seeding is best-effort; a missing auth file must not block launch.
    }
  }
}

function linkSeedDirs(
  seed: ProviderSeedSpec,
  home: string,
  homeDir: string,
  env: NodeJS.ProcessEnv
): void {
  for (const entry of seed.link ?? []) {
    const source = resolveSeedSource(entry, homeDir, env)
    if (source === null) continue
    try {
      const target = join(home, safeRelativePath(entry.target))
      if (existsSync(target)) continue
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // A refused link must not block the launch.
    }
  }
}

export function materializeProviderLaunch(options: {
  userDataDir: string
  homeDir: string
  provider: MaterializableProvider
  target: ExecutionTarget
  env?: NodeJS.ProcessEnv
}): ProviderMaterializeResult {
  const recipe = PROVIDER_RECIPES[options.provider.harness]
  return materializePlan({
    userDataDir: options.userDataDir,
    homeDir: options.homeDir,
    env: options.env,
    providerId: options.provider.id,
    plan: providerLaunchPlan(options.provider),
    seed: recipe.seed,
    target: options.target
  })
}

/**
 * The pure plan-to-disk half, exported so delivery shapes can be tested before
 * the recipes that use them land.
 */
export function materializePlan(options: {
  userDataDir: string
  providerId: string
  plan: ProviderLaunchPlan
  target: ExecutionTarget
  seed?: ProviderSeedSpec
  homeDir?: string
  env?: NodeJS.ProcessEnv
}): ProviderMaterializeResult {
  const { plan } = options
  const delivery = plan.delivery
  if (delivery === undefined || delivery.kind === 'env') {
    return { args: plan.args, env: plan.env }
  }

  const homeDir = options.homeDir ?? ''
  const env = options.env ?? process.env
  const seedText = readSeedText(options.seed, homeDir, env)

  const guest = options.target.kind === 'wsl'
  const visible = (windowsPath: string): string => {
    if (!guest) return windowsPath
    // Only absolute drive paths can be respelled for a distro. A UNC or
    // already-posix userData path would be passed through unchanged and the
    // harness would fail to open it, so refuse with a clear error instead.
    if (!/^[A-Za-z]:[\\/]/u.test(windowsPath)) {
      throw new ProviderDeliveryPathError(windowsPath)
    }
    return toGuestVisiblePath(windowsPath)
  }

  const root = providerRoot(options.userDataDir, options.providerId)

  if (delivery.kind === 'file') {
    const relativePath = safeRelativePath(delivery.relativePath)
    const contents =
      seedText === null
        ? delivery.contents
        : mergeSeedText(seedText, delivery.contents, delivery.format)
    const directory = join(root, sha16(`${relativePath}\n${contents}`))
    const filePath = join(directory, relativePath)
    // Resolve the guest spelling before writing so an unopenable userData path
    // fails without leaving a file behind.
    const seen = visible(filePath)

    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeTextAtomic(filePath, contents, { defaultMode: 0o600 })

    const env = { ...plan.env }
    if (delivery.pathEnv !== undefined) env[delivery.pathEnv] = seen
    const args = [...plan.args]
    if (delivery.pathArgs !== undefined) {
      for (const template of delivery.pathArgs) {
        args.push(template.replaceAll('{path}', seen))
      }
    }
    return { args, env }
  }

  const home = join(root, 'home')
  const seenHome = visible(home)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (options.seed !== undefined) {
    copySeedFiles(options.seed, home, homeDir, env)
    linkSeedDirs(options.seed, home, homeDir, env)
  }
  writeTextAtomic(
    join(home, GENERATED_MARKER),
    JSON.stringify({
      managedBy: 'icode',
      providerId: options.providerId
    }),
    { defaultMode: 0o600 }
  )
  for (const file of delivery.files) {
    const filePath = join(home, safeRelativePath(file.relativePath))
    const contents =
      seedText !== null && options.seed?.target === file.relativePath
        ? mergeSeedText(seedText, file.contents, formatForPath(file.relativePath))
        : file.contents
    writeTextAtomic(filePath, contents, {
      defaultMode: file.mode ?? 0o600
    })
  }

  return {
    args: plan.args,
    env: { ...plan.env, [delivery.pathEnv]: seenHome }
  }
}

/** Best-effort startup retention for content-addressed file deliveries. */
export function pruneProviderRuntime(
  userDataDir: string,
  now: number,
  maxAgeMs = DEFAULT_MAX_AGE_MS
): void {
  const base = join(userDataDir, RUNTIME_DIRECTORY)
  let providers: string[]
  try {
    providers = readdirSync(base)
  } catch {
    return
  }
  for (const provider of providers) {
    const providerDir = join(base, provider)
    let entries: string[]
    try {
      entries = readdirSync(providerDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      // `home` holds real session state and is never pruned by age.
      if (entry === 'home') continue
      const path = join(providerDir, entry)
      try {
        if (now - statSync(path).mtimeMs > maxAgeMs) {
          rmSync(path, { recursive: true, force: true })
        }
      } catch {
        // A concurrent delete or permission error is not worth failing startup.
      }
    }
    try {
      if (readdirSync(providerDir).length === 0) {
        rmSync(providerDir, { recursive: true, force: true })
      }
    } catch {
      // Best effort.
    }
  }
}

/**
 * Deletes a provider's generated runtime data. File deliveries are ours and go
 * unconditionally; a `home` is removed only when the marker proves iCode
 * generated it.
 */
export function removeProviderRuntime(userDataDir: string, providerId: string): void {
  const root = providerRoot(userDataDir, providerId)
  if (!existsSync(root)) return
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(root, entry)
    if (entry === 'home') {
      if (!existsSync(join(path, GENERATED_MARKER))) continue
    }
    rmSync(path, { recursive: true, force: true })
  }
  try {
    if (readdirSync(root).length === 0) {
      rmSync(root, { recursive: true, force: true })
    }
  } catch {
    // Best effort.
  }
}
