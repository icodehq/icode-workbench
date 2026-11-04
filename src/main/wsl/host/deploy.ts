/**
 * Materializes the W3 Linux Host tree inside a distro and proves it landed.
 *
 * This module consumes W3's artifacts; it does not build them. Two integrity
 * gates, because a transfer can fail in two different ways:
 *
 *   1. **Before upload** the local tree is hashed against `manifest.json`. A
 *      corrupted artifact set must fail here, not in the guest.
 *   2. **After materialization** the guest re-hashes every file *using the pinned
 *      Node runtime that was just uploaded*. That is deliberate: it proves the
 *      deployed bytes AND that the runtime we intend to start actually executes
 *      on this distro, instead of merely hoping the host architecture is right.
 *
 * No shell string is ever built from a path: paths travel as argv, and the
 * scripts are constants.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { AppError } from '../../../shared/domain/errors'
import { makeAppError } from '../../../shared/domain/errors'
import type { WslCommandRunner, WslExecFailureStatus } from '../exec'

export const MANIFEST_FILENAME = 'manifest.json'
/** The only executable the tree needs; node-pty is loaded, not executed. */
const EXECUTABLE_FILES = ['node/bin/node'] as const
const VERIFY_SCRIPT_FILENAME = '.icode-verify.cjs'
const MARKER_FILENAME = '.icode-deployed'
const UPLOAD_TIMEOUT_MS = 120_000
/**
 * One retry per file. A `wsl.exe` upload can fail transiently (observed once on
 * this machine with an empty stderr), and 123 MB across 43 processes makes that
 * likely enough to matter. Bounded at two attempts: no unbounded loop, and a
 * genuinely missing path still fails on the second try.
 */
const MAX_UPLOAD_ATTEMPTS = 2
/** 121 MB runtime plus the rest of the tree, generously bounded. */
export const DEPLOY_TIMEOUT_MS = 300_000

export type HostArtifactManifest = {
  artifactVersion: string
  architecture: string
  glibcBaseline: string
  node: { version: string; sha256: string }
  native: { package: string; version: string; sha256: string }
  host: { bundle: string; sha256: string }
  files: Record<string, string>
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function parseHostArtifactManifest(text: string): HostArtifactManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const root = asObject(parsed)
  if (!root) return null

  const artifactVersion = nonEmpty(root.artifactVersion)
  const architecture = nonEmpty(root.architecture)
  const glibcBaseline = nonEmpty(root.glibcBaseline)
  const node = asObject(root.node)
  const native = asObject(root.native)
  const host = asObject(root.host)
  const files = asObject(root.files)
  const nodeVersion = node ? nonEmpty(node.version) : null
  const nodeSha = node ? nonEmpty(node.sha256) : null
  const nativePackage = native ? nonEmpty(native.package) : null
  const nativeVersion = native ? nonEmpty(native.version) : null
  const nativeSha = native ? nonEmpty(native.sha256) : null
  const hostBundle = host ? nonEmpty(host.bundle) : null
  const hostSha = host ? nonEmpty(host.sha256) : null
  if (
    artifactVersion === null ||
    architecture === null ||
    glibcBaseline === null ||
    nodeVersion === null ||
    nodeSha === null ||
    nativePackage === null ||
    nativeVersion === null ||
    nativeSha === null ||
    hostBundle === null ||
    hostSha === null ||
    !files
  ) {
    return null
  }

  const hashes: Record<string, string> = {}
  for (const [relative, value] of Object.entries(files)) {
    const hash = nonEmpty(value)
    // A manifest entry without a hash cannot be verified, so the manifest is
    // rejected rather than partially trusted.
    if (hash === null || !/^[0-9a-f]{64}$/u.test(hash)) return null
    hashes[relative] = hash
  }
  if (hashes[hostBundle] === undefined) return null

  return {
    artifactVersion,
    architecture,
    glibcBaseline,
    node: { version: nodeVersion, sha256: nodeSha },
    native: { package: nativePackage, version: nativeVersion, sha256: nativeSha },
    host: { bundle: hostBundle, sha256: hostSha },
    files: hashes
  }
}

/**
 * The deployed build's identity: artifact version plus the Host bundle hash.
 * Adopting a Host that runs a different bundle would run stale code.
 */
export function buildFingerprint(manifest: HostArtifactManifest): string {
  return `${manifest.artifactVersion}:${manifest.host.sha256}`
}

export type LocalVerifyResult =
  | { ok: true; checked: number }
  | {
      ok: false
      kind: 'missing' | 'unreadable' | 'mismatch'
      path: string
      expected: string | null
      actual: string | null
    }

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Hashes the local tree against the manifest.
 *
 * Streaming, not `readFileSync`: the runtime is 121 MB and a deployment should
 * not need that much heap to prove it is intact.
 */
export async function verifyLocalArtifacts(
  artifactRoot: string,
  manifest: HostArtifactManifest
): Promise<LocalVerifyResult> {
  let checked = 0
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const absolute = join(artifactRoot, relative)
    let actual: string
    try {
      actual = await hashFile(absolute)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        ok: false,
        kind: code === 'ENOENT' ? 'missing' : 'unreadable',
        path: relative,
        expected,
        actual: null
      }
    }
    checked += 1
    if (actual !== expected) {
      return { ok: false, kind: 'mismatch', path: relative, expected, actual }
    }
  }
  return { ok: true, checked }
}

/** Everything inside the distro that a deployment owns. */
export type DeployPaths = {
  root: string
  entry: string
  node: string
  manifest: string
  marker: string
  verifyScript: string
  runDir: string
  socket: string
  pidFile: string
  metaPath: string
  logPath: string
  /** `ICODE_HOST_DIR/token`; the Host's own `writeToken` location. */
  tokenPath: string
}

/**
 * `<hostRoot>/<artifactVersion>` per build, so two builds never share files and a
 * rollback is a different directory rather than a rewrite in place.
 */
export function deployPathsFor(hostRoot: string, artifactVersion: string): DeployPaths {
  const root = `${hostRoot.replace(/\/+$/u, '')}/${artifactVersion}`
  const runDir = `${root}/run`
  return {
    root,
    entry: `${root}/host/index.js`,
    node: `${root}/node/bin/node`,
    manifest: `${root}/${MANIFEST_FILENAME}`,
    marker: `${root}/${MARKER_FILENAME}`,
    verifyScript: `${root}/${VERIFY_SCRIPT_FILENAME}`,
    runDir,
    socket: `${runDir}/host.sock`,
    pidFile: `${runDir}/host.pid`,
    metaPath: `${runDir}/meta.json`,
    logPath: `${runDir}/startup.log`,
    // The Host writes its token to `ICODE_HOST_DIR`, which is the run directory.
    tokenPath: `${runDir}/token`
  }
}

/**
 * Constant guest-side verifier. Runs under the pinned Node, reads the manifest it
 * was deployed with, and prints one JSON line.
 */
export const GUEST_VERIFY_SCRIPT = `'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const root = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
let checked = 0
const mismatches = []
for (const rel of Object.keys(manifest.files)) {
  checked += 1
  try {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')
    if (actual !== manifest.files[rel]) mismatches.push(rel)
  } catch {
    mismatches.push(rel + ': missing')
  }
}
process.stdout.write(JSON.stringify({ checked, mismatches }))
`

const MKDIR_SCRIPT = 'umask 077; mkdir -p "$@" && chmod 700 "$@" 2>/dev/null; exit 0'
const CHMOD_SCRIPT = 'chmod 755 "$1"'
const READ_SCRIPT = 'cat "$1" 2>/dev/null'
const WRITE_SCRIPT = 'umask 077; cat > "$1"'
const RUN_VERIFY_SCRIPT = 'exec "$1" "$2" "$3"'

export type DeployOutcome =
  | {
      status: 'deployed'
      paths: DeployPaths
      fingerprint: string
      uploaded: number
      /** True when the marker proved this exact build was already in place. */
      reused: boolean
    }
  | { status: 'invalid_artifacts'; failure: LocalVerifyResult; error: AppError }
  | { status: 'upload_failed'; path: string; error: AppError }
  | { status: 'verification_failed'; checked: number; mismatches: string[]; error: AppError }
  | { status: 'unavailable'; reason: WslExecFailureStatus; error: AppError }

export type DeployDeps = {
  runner: WslCommandRunner
  distro: string
  artifactRoot: string
  /** `<home>/.icode/host/<profileScope>` — caller supplies the scope. */
  hostRoot: string
  manifest: HostArtifactManifest
  signal?: AbortSignal
  /** Test seam: hashes without touching a real tree. */
  verifyLocal?: (
    root: string,
    manifest: HostArtifactManifest
  ) => Promise<LocalVerifyResult>
}

function deployError(
  code: 'WSL_HOST_DEPLOY_FAILED',
  message: string,
  detail: string
): AppError {
  return makeAppError(code, message, { detail })
}

/**
 * Deploys the tree, or reports precisely which gate failed.
 *
 * Idempotent by fingerprint: a matching marker means the exact build is already
 * materialized and verified, so a reconnect costs one `cat` instead of 123 MB.
 */
export async function deployHost(deps: DeployDeps): Promise<DeployOutcome> {
  const verifyLocal = deps.verifyLocal ?? verifyLocalArtifacts
  const fingerprint = buildFingerprint(deps.manifest)

  const local = await verifyLocal(deps.artifactRoot, deps.manifest)
  if (!local.ok) {
    return {
      status: 'invalid_artifacts',
      failure: local,
      error: deployError(
        'WSL_HOST_DEPLOY_FAILED',
        'The Host artifacts do not match their manifest.',
        local.kind === 'mismatch'
          ? `${local.path} does not match the manifest hash.`
          : `${local.path} could not be read (${local.kind}).`
      )
    }
  }

  const paths = deployPathsFor(deps.hostRoot, deps.manifest.artifactVersion)
  const upload = async (
    argv: readonly string[],
    options: { stdin?: string; stdinFile?: string; timeoutMs?: number } = {}
  ) =>
    deps.runner.run({
      scope: 'guest',
      distro: deps.distro,
      argv,
      timeoutMs: options.timeoutMs ?? UPLOAD_TIMEOUT_MS,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.stdinFile !== undefined ? { stdinFile: options.stdinFile } : {}),
      ...(deps.signal ? { signal: deps.signal } : {})
    })

  // Reuse only when the marker names this exact build.
  const markerRead = await upload(['sh', '-c', READ_SCRIPT, 'icode-read', paths.marker])
  if (markerRead.status === 'ok' && markerRead.stdout.trim() === fingerprint) {
    return { status: 'deployed', paths, fingerprint, uploaded: 0, reused: true }
  }

  const directories = new Set<string>([paths.root, paths.runDir])
  for (const relative of Object.keys(deps.manifest.files)) {
    const absolute = `${paths.root}/${relative}`
    const slash = absolute.lastIndexOf('/')
    if (slash > 0) directories.add(absolute.slice(0, slash))
  }
  const mkdir = await upload(['sh', '-c', MKDIR_SCRIPT, 'icode-mkdir', ...directories])
  if (mkdir.status !== 'ok') {
    return {
      status: 'unavailable',
      reason: mkdir.status === 'wsl_missing' ? 'wsl_missing' : mkdir.status,
      error: deployError(
        'WSL_HOST_DEPLOY_FAILED',
        'Could not prepare the Host directory inside the distro.',
        mkdir.status === 'exit_failure' ? mkdir.stderr.trim().slice(0, 400) : mkdir.status
      )
    }
  }

  const writeFile = async (absolute: string, source: { file: string } | { text: string }) => {
    const options = 'file' in source ? { stdinFile: source.file } : { stdin: source.text }
    let result = await upload(['sh', '-c', WRITE_SCRIPT, 'icode-write', absolute], options)
    for (let attempt = 2; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      if (result.status === 'ok') break
      // A missing artifact is not transient, but it is re-verified locally on the
      // next attempt only at the manifest level; a single retry is the cheap case.
      result = await upload(['sh', '-c', WRITE_SCRIPT, 'icode-write', absolute], options)
    }
    return { absolute, result }
  }

  let uploaded = 0
  for (const [relative] of Object.entries(deps.manifest.files)) {
    const written = await writeFile(`${paths.root}/${relative}`, {
      file: join(deps.artifactRoot, relative)
    })
    if (written.result.status !== 'ok') {
      return {
        status: 'upload_failed',
        path: relative,
        error: deployError(
          'WSL_HOST_DEPLOY_FAILED',
          'Could not upload the Host artifacts into the distro.',
          `${relative}: ${
            written.result.status === 'exit_failure'
              ? written.result.stderr.trim().slice(0, 300)
              : written.result.status
          }`
        )
      }
    }
    uploaded += 1
  }

  // The manifest and the verifier are part of the deployed tree, but not of the
  // hash list: the manifest cannot contain its own hash, and the verifier is
  // written by the controller.
  const manifestWrite = await writeFile(paths.manifest, {
    file: join(deps.artifactRoot, MANIFEST_FILENAME)
  })
  if (manifestWrite.result.status !== 'ok') {
    return {
      status: 'upload_failed',
      path: MANIFEST_FILENAME,
      error: deployError(
        'WSL_HOST_DEPLOY_FAILED',
        'Could not upload the Host manifest into the distro.',
        manifestWrite.result.status
      )
    }
  }
  await writeFile(paths.verifyScript, { text: GUEST_VERIFY_SCRIPT })

  for (const executable of EXECUTABLE_FILES) {
    const chmod = await upload([
      'sh',
      '-c',
      CHMOD_SCRIPT,
      'icode-chmod',
      `${paths.root}/${executable}`
    ])
    if (chmod.status !== 'ok') {
      return {
        status: 'upload_failed',
        path: executable,
        error: deployError(
          'WSL_HOST_DEPLOY_FAILED',
          'Could not make the pinned runtime executable.',
          `${executable}: ${chmod.status}`
        )
      }
    }
  }

  const verify = await deps.runner.run({
    scope: 'guest',
    distro: deps.distro,
    argv: [
      'sh',
      '-c',
      RUN_VERIFY_SCRIPT,
      'icode-verify',
      paths.node,
      paths.verifyScript,
      paths.root
    ],
    timeoutMs: DEPLOY_TIMEOUT_MS,
    ...(deps.signal ? { signal: deps.signal } : {})
  })
  if (verify.status !== 'ok') {
    return {
      status: 'verification_failed',
      checked: 0,
      mismatches: [],
      error: deployError(
        'WSL_HOST_DEPLOY_FAILED',
        'The deployed Host tree could not be verified inside the distro.',
        verify.status === 'exit_failure'
          ? `the pinned runtime did not run the verifier: ${verify.stderr.trim().slice(0, 380)}`
          : `the pinned runtime did not run (${verify.status})`
      )
    }
  }

  const parsed = (() => {
    try {
      const value: unknown = JSON.parse(verify.stdout.trim())
      const fields = asObject(value)
      const checked = fields?.checked
      const mismatches = fields?.mismatches
      if (typeof checked !== 'number' || !Array.isArray(mismatches)) return null
      return { checked, mismatches: mismatches.filter((m): m is string => typeof m === 'string') }
    } catch {
      return null
    }
  })()
  if (parsed === null) {
    return {
      status: 'verification_failed',
      checked: 0,
      mismatches: [],
      error: deployError(
        'WSL_HOST_DEPLOY_FAILED',
        'The deployed Host tree did not answer its integrity check.',
        verify.stdout.trim().slice(0, 200)
      )
    }
  }
  if (parsed.mismatches.length > 0) {
    return {
      status: 'verification_failed',
      checked: parsed.checked,
      mismatches: parsed.mismatches,
      error: deployError(
        'WSL_HOST_DEPLOY_FAILED',
        'The deployed Host tree does not match the artifact manifest.',
        `${parsed.mismatches.length} file(s) differ, first: ${parsed.mismatches[0]}`
      )
    }
  }

  // Written last: a marker is a promise that the tree verified, so an interrupted
  // deployment must never leave one behind.
  await upload(['sh', '-c', WRITE_SCRIPT, 'icode-marker', paths.marker], {
    stdin: fingerprint
  })

  return { status: 'deployed', paths, fingerprint, uploaded, reused: false }
}
