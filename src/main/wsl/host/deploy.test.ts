import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WslProcessLauncher } from '../exec'
import { WslCommandRunner } from '../exec'
import {
  buildFingerprint,
  deployHost,
  deployPathsFor,
  GUEST_VERIFY_SCRIPT,
  MANIFEST_FILENAME,
  parseHostArtifactManifest,
  verifyLocalArtifacts,
  type HostArtifactManifest
} from './deploy'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** A tiny artifact tree with the same shape as the real one. */
function makeArtifactTree(): { root: string; manifest: HostArtifactManifest; text: string } {
  const root = mkdtempSync(join(tmpdir(), 'icode-w58-artifacts-'))
  roots.push(root)
  const files: Record<string, string> = {}
  const contents: Array<[string, Buffer]> = [
    ['host/index.js', Buffer.from('console.log("host")\n')],
    ['node/bin/node', Buffer.from('#!/bin/sh\necho node\n')],
    ['node_modules/node-pty/build/Release/pty.node', Buffer.from('binary-ish payload')],
    ['node_modules/node-pty/package.json', Buffer.from('{"name":"node-pty"}\n')]
  ]
  for (const [relative, content] of contents) {
    const absolute = join(root, relative)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
    files[relative] = sha(content.toString('binary'))
    // sha over a Buffer must hash bytes, not a re-encoded string
    files[relative] = createHash('sha256').update(content).digest('hex')
  }
  const manifest: HostArtifactManifest = {
    artifactVersion: 'v-test',
    architecture: 'x64',
    glibcBaseline: '2.35',
    node: { version: 'v24.21.0', sha256: files['node/bin/node']! },
    native: { package: 'node-pty', version: '1.1.0', sha256: files['node_modules/node-pty/build/Release/pty.node']! },
    host: { bundle: 'host/index.js', sha256: files['host/index.js']! },
    files
  }
  const text = JSON.stringify(manifest, null, 2)
  writeFileSync(join(root, MANIFEST_FILENAME), text)
  return { root, manifest, text }
}

describe('manifest', () => {
  it('parses the real W3 manifest shape', () => {
    const { manifest } = makeArtifactTree()
    const parsed = parseHostArtifactManifest(JSON.stringify(manifest))
    expect(parsed?.artifactVersion).toBe('v-test')
    expect(Object.keys(parsed!.files)).toHaveLength(4)
  })

  it('rejects a manifest entry without a valid hash', () => {
    const { manifest } = makeArtifactTree()
    const broken = { ...manifest, files: { ...manifest.files, 'host/index.js': 'short' } }
    expect(parseHostArtifactManifest(JSON.stringify(broken))).toBeNull()
  })

  it('rejects a manifest whose host bundle is not in the file list', () => {
    const { manifest } = makeArtifactTree()
    const broken = { ...manifest, host: { bundle: 'absent.js', sha256: manifest.host.sha256 } }
    expect(parseHostArtifactManifest(JSON.stringify(broken))).toBeNull()
  })

  it('derives a fingerprint from version and bundle hash', () => {
    const { manifest } = makeArtifactTree()
    expect(buildFingerprint(manifest)).toBe(`v-test:${manifest.host.sha256}`)
  })

  it('gives two builds different paths and a stable path per build', () => {
    const a = deployPathsFor('/home/u/.icode/host/scope', 'v1')
    const b = deployPathsFor('/home/u/.icode/host/scope', 'v2')
    expect(a.root).toBe('/home/u/.icode/host/scope/v1')
    expect(a.root).not.toBe(b.root)
    expect(a.pidFile).toBe('/home/u/.icode/host/scope/v1/run/host.pid')
  })
})

describe('local artifact verification', () => {
  it('hashes the tree against the manifest', async () => {
    const { root, manifest } = makeArtifactTree()
    await expect(verifyLocalArtifacts(root, manifest)).resolves.toEqual({ ok: true, checked: 4 })
  })

  it('detects a modified file before anything is uploaded', async () => {
    const { root, manifest } = makeArtifactTree()
    writeFileSync(join(root, 'host/index.js'), 'tampered\n')
    const result = await verifyLocalArtifacts(root, manifest)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('mismatch')
      expect(result.path).toBe('host/index.js')
    }
  })

  it('detects a missing file', async () => {
    const { root, manifest } = makeArtifactTree()
    rmSync(join(root, 'node_modules/node-pty/package.json'))
    const result = await verifyLocalArtifacts(root, manifest)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('missing')
  })
})

describe('deployment', () => {
  function runnerFor(script: {
    marker?: string
    failOn?: (argv: readonly string[]) => boolean
    verifyStdout?: string
  }): { runner: WslCommandRunner; calls: string[][] } {
    const calls: string[][] = []
    const launcher: WslProcessLauncher = async (spec) => {
      const argv = spec.args
      calls.push([...argv])
      const guestArgv = argv.slice(argv.indexOf('--exec') + 1)
      if (script.failOn?.(guestArgv)) {
        const stderr = guestArgv.includes('icode-verify')
          ? 'node: cannot execute /tree/node/bin/node'
          : 'upload failed'
        return { code: 1, signal: null, stdout: '', stderr, timedOut: false }
      }
      // The marker read is the only call whose target is the marker file.
      if (guestArgv.includes('icode-read')) {
        return {
          code: 0,
          signal: null,
          stdout: script.marker ?? '',
          stderr: '',
          timedOut: false
        }
      }
      if (guestArgv.includes('icode-verify')) {
        return {
          code: 0,
          signal: null,
          stdout: script.verifyStdout ?? JSON.stringify({ checked: 4, mismatches: [] }),
          stderr: '',
          timedOut: false
        }
      }
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    return { runner: new WslCommandRunner({ launcher, platform: 'win32' }), calls }
  }

  const outcomeOf = (value: unknown) => value as Awaited<ReturnType<typeof deployHost>>

  it('uploads every manifest file, then verifies them in the guest', async () => {
    const { root, manifest } = makeArtifactTree()
    const { runner, calls } = runnerFor({})
    const outcome = outcomeOf(
      await deployHost({
        runner,
        distro: 'Ubuntu-26.04',
        artifactRoot: root,
        hostRoot: '/home/u/.icode/host/scope',
        manifest
      })
    )
    expect(outcome.status).toBe('deployed')
    if (outcome.status !== 'deployed') return
    expect(outcome.uploaded).toBe(4)
    expect(outcome.reused).toBe(false)
    // 4 files + manifest + verify script + dirs + chmod + verify + marker
    expect(calls.length).toBeGreaterThanOrEqual(9)
    expect(calls.some((argv) => argv.includes('icode-verify'))).toBe(true)
  })

  it('reuses a tree whose marker names this exact build', async () => {
    const { root, manifest } = makeArtifactTree()
    const { runner, calls } = runnerFor({ marker: buildFingerprint(manifest) })
    const outcome = outcomeOf(
      await deployHost({
        runner,
        distro: 'Ubuntu-26.04',
        artifactRoot: root,
        hostRoot: '/home/u/.icode/host/scope',
        manifest
      })
    )
    expect(outcome.status).toBe('deployed')
    if (outcome.status === 'deployed') {
      expect(outcome.reused).toBe(true)
      expect(outcome.uploaded).toBe(0)
    }
    // One read, and nothing else: a reconnect must not move 123 MB.
    expect(calls).toHaveLength(1)
  })

  it('refuses to upload when the local tree does not match its manifest', async () => {
    const { root, manifest } = makeArtifactTree()
    writeFileSync(join(root, 'host/index.js'), 'tampered\n')
    const { runner, calls } = runnerFor({})
    const outcome = outcomeOf(
      await deployHost({
        runner,
        distro: 'Ubuntu-26.04',
        artifactRoot: root,
        hostRoot: '/home/u/.icode/host/scope',
        manifest
      })
    )
    expect(outcome.status).toBe('invalid_artifacts')
    if (outcome.status === 'invalid_artifacts') {
      expect(outcome.error.code).toBe('WSL_HOST_DEPLOY_FAILED')
      expect(outcome.error.detail).toContain('host/index.js')
    }
    // Verification failed before a single byte was sent.
    expect(calls).toHaveLength(0)
  })

  it('reports which file failed to upload', async () => {
    const { root, manifest } = makeArtifactTree()
    const { runner } = runnerFor({
      failOn: (argv) => argv.some((arg) => arg.endsWith('node_modules/node-pty/package.json'))
    })
    const outcome = outcomeOf(
      await deployHost({
        runner,
        distro: 'Ubuntu-26.04',
        artifactRoot: root,
        hostRoot: '/home/u/.icode/host/scope',
        manifest
      })
    )
    expect(outcome.status).toBe('upload_failed')
    if (outcome.status === 'upload_failed') {
      expect(outcome.path).toBe('node_modules/node-pty/package.json')
    }
  })

  it('fails when the guest reports a hash mismatch', async () => {
    const { root, manifest } = makeArtifactTree()
    const { runner } = runnerFor({
      verifyStdout: JSON.stringify({ checked: 4, mismatches: ['host/index.js'] })
    })
    const outcome = outcomeOf(
      await deployHost({
        runner,
        distro: 'Ubuntu-26.04',
        artifactRoot: root,
        hostRoot: '/home/u/.icode/host/scope',
        manifest
      })
    )
    expect(outcome.status).toBe('verification_failed')
    if (outcome.status === 'verification_failed') {
      expect(outcome.mismatches).toContain('host/index.js')
    }
  })

  it('fails when the pinned runtime cannot run the verifier', async () => {
    const { root, manifest } = makeArtifactTree()
    const { runner } = runnerFor({ failOn: (argv) => argv.includes('icode-verify') })
    const outcome = outcomeOf(
      await deployHost({
        runner,
        distro: 'Ubuntu-26.04',
        artifactRoot: root,
        hostRoot: '/home/u/.icode/host/scope',
        manifest
      })
    )
    expect(outcome.status).toBe('verification_failed')
    if (outcome.status === 'verification_failed') {
      expect(outcome.error.detail).toMatch(/pinned runtime|exit/i)
    }
  })

  it('retries one transient upload instead of failing the whole deployment', async () => {
    const { root, manifest } = makeArtifactTree()
    let failedOnce = false
    const calls: string[][] = []
    const launcher: WslProcessLauncher = async (spec) => {
      const guest = spec.args.slice(spec.args.indexOf('--exec') + 1)
      calls.push([...guest])
      const isTargetUpload =
        guest.includes('icode-write') && guest.some((arg) => arg.endsWith('node-pty/package.json'))
      if (isTargetUpload && !failedOnce) {
        failedOnce = true
        return { code: 1, signal: null, stdout: '', stderr: '', timedOut: false }
      }
      if (guest.includes('icode-read')) {
        return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
      }
      if (guest.includes('icode-verify')) {
        return { code: 0, signal: null, stdout: JSON.stringify({ checked: 4, mismatches: [] }), stderr: '', timedOut: false }
      }
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    const outcome = await deployHost({
      runner: new WslCommandRunner({ launcher, platform: 'win32' }),
      distro: 'Ubuntu-26.04',
      artifactRoot: root,
      hostRoot: '/home/u/.icode/host/scope',
      manifest
    })
    expect(outcome.status).toBe('deployed')
    const targetWrites = calls.filter(
      (guest) => guest.includes('icode-write') && guest.some((arg) => arg.endsWith('node-pty/package.json'))
    )
    expect(targetWrites).toHaveLength(2)
  })

  it('still fails after the bounded retry is exhausted', async () => {
    const { root, manifest } = makeArtifactTree()
    const { runner } = runnerFor({
      failOn: (argv) => argv.some((arg) => arg.endsWith('node-pty/package.json'))
    })
    const outcome = await deployHost({
      runner,
      distro: 'Ubuntu-26.04',
      artifactRoot: root,
      hostRoot: '/home/u/.icode/host/scope',
      manifest
    })
    expect(outcome.status).toBe('upload_failed')
  })

  it('does not write a marker when verification failed', async () => {
    const { root, manifest } = makeArtifactTree()
    const { runner, calls } = runnerFor({
      verifyStdout: JSON.stringify({ checked: 4, mismatches: ['host/index.js'] })
    })
    await deployHost({
      runner,
      distro: 'Ubuntu-26.04',
      artifactRoot: root,
      hostRoot: '/home/u/.icode/host/scope',
      manifest
    })
    expect(calls.some((argv) => argv.includes('icode-marker'))).toBe(false)
  })

  it('verifies with the pinned node, never a system interpreter', async () => {
    const { root, manifest } = makeArtifactTree()
    const { runner, calls } = runnerFor({})
    await deployHost({
      runner,
      distro: 'Ubuntu-26.04',
      artifactRoot: root,
      hostRoot: '/home/u/.icode/host/scope',
      manifest
    })
    const verifyCall = calls.find((argv) => argv.includes('icode-verify'))!
    const paths = deployPathsFor('/home/u/.icode/host/scope', manifest.artifactVersion)
    expect(verifyCall).toContain(paths.node)
    expect(verifyCall).toContain(paths.verifyScript)
  })

  it('ships a verifier that reads the deployed manifest rather than a baked-in list', () => {
    expect(GUEST_VERIFY_SCRIPT).toContain("readFileSync(path.join(root, 'manifest.json')")
    expect(GUEST_VERIFY_SCRIPT).toContain('manifest.files')
  })
})
