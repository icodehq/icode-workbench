'use strict'

/**
 * Prepares the Linux Host artifact tree before packaging.
 *
 * Why this exists: a packaged WSL Agent deploys its Guest Host from
 * `resources/artifacts/wsl-host/linux-x64`, and W66 proved that a package without
 * that tree still *builds* — it just fails every Agent session at run time with
 * "The Linux Host artifacts are missing." Packaging therefore has to treat the
 * artifacts as an input it is responsible for, not as something a developer
 * happened to leave on disk.
 *
 * Order of operations:
 *   1. **Verify first.** A tree whose manifest verifies is already correct, so it
 *      is used as-is: no Docker, no network, no second copy of the bytes.
 *   2. **Build when absent.** `host-artifacts.cjs build` is the project's
 *      reproducible builder (pinned Docker image, node-pty built twice, hashes
 *      compared). A missing tree is normal on a fresh checkout, so packaging
 *      produces it rather than demanding a developer stage it first.
 *   3. **Verify what was built.** A build that produces an unverifiable tree is a
 *      failed build, not a usable one.
 *
 * A tree that is *present but does not verify* is treated differently: packaging
 * stops and reports the exact defect. Silently rebuilding would hide a corrupted
 * or half-copied tree behind several minutes of Docker, and the operator needs to
 * know that what they had was not what they thought. `--rebuild` is the explicit
 * way to replace it.
 *
 * Every failure exits non-zero with what is wrong and what to do about it, because
 * the alternative — electron-builder's own reaction to a missing `extraResources`
 * source — is a warning followed by a successfully produced broken installer.
 *
 * Nothing here runs concurrently with electron-builder: the caller chains this
 * with `&&`, so packaging starts only after this process has exited 0.
 */

const path = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const verifier = require('./verify-artifacts.cjs')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const ARTIFACT_ROOT = path.join(REPO_ROOT, 'artifacts', 'wsl-host', 'linux-x64')
const MANIFEST = path.join(ARTIFACT_ROOT, 'manifest.json')

/** Docs the error text points at, so a failure is actionable without context. */
const BUILD_HINT =
  'Run "pnpm build:wsl-host" on Linux with Docker, or build with "pnpm package:win" ' +
  'which prepares the artifacts itself.'

function log(message) {
  process.stdout.write(`[prepare-artifacts] ${message}\n`)
}

/**
 * The runtime files the packaged app cannot start without.
 *
 * `verifyTree` covers these through the manifest, but naming them here means a
 * failure says *which* capability is missing rather than only "absent".
 */
const RUNTIME_FILES = [
  { file: 'host/index.js', role: 'the deployed Guest Host bundle' },
  { file: 'node/bin/node', role: 'the Guest Host runtime' },
  {
    file: 'node_modules/node-pty/build/Release/pty.node',
    role: 'the Guest PTY native module'
  }
]

/**
 * Whether the ELF inspection can run here.
 *
 * `verifyTree` re-reads `pty.node` with `objdump` to prove the glibc floor. That
 * tool is part of binutils on Linux and absent on Windows, where packaging
 * happens. The hash checks it performs are targeted: they prove the packaged
 * bytes are exactly the bytes that were built and inspected. So when `objdump`
 * is missing the tree is still verified on hashes and structure, and the skip is
 * reported rather than silently treated as a pass.
 */
function canInspectNative() {
  try {
    execFileSync('objdump', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function verifyExisting() {
  const nativeCheck = canInspectNative()
  const { manifest, fileCount } = verifier.verifyTree(ARTIFACT_ROOT, { nativeCheck })
  for (const entry of RUNTIME_FILES) {
    if (!fs.existsSync(path.join(ARTIFACT_ROOT, entry.file))) {
      throw new verifier.ArtifactError(
        `artifact tree is missing ${entry.file} (${entry.role}); ${BUILD_HINT}`
      )
    }
  }
  log(`verified ${fileCount} files (${manifest.artifactVersion})`)
  log(
    nativeCheck
      ? `glibc floor re-inspected: glibc ${manifest.glibcBaseline}, max GLIBC_${manifest.maxGlibcSymbol}`
      : `objdump is unavailable on this host, so the ELF inspection was not repeated; ` +
        `the hashes still pin the exact bytes recorded as glibc ${manifest.glibcBaseline}`
  )
}

function buildFresh() {
  if (!fs.existsSync(path.join(REPO_ROOT, 'out', 'host', 'index.js'))) {
    throw new verifier.ArtifactError(
      'out/host/index.js is missing, so the artifact tree cannot be assembled. ' +
        'Run "pnpm build:app" first; "pnpm package:win" does this for you.'
    )
  }
  log('no verified tree present; building one (this uses Docker and the network)')
  // Required lazily: `host-artifacts.cjs` is only needed when something must be
  // built, so a verify-only run never depends on the builder being loadable.
  const builder = require('./host-artifacts.cjs')
  builder.build({ out: ARTIFACT_ROOT })
}

function main(argv = []) {
  const rebuild = argv.includes('--rebuild')
  try {
    if (rebuild) {
      log('--rebuild requested: replacing the artifact tree')
      buildFresh()
      verifyExisting()
      return 0
    }
    if (fs.existsSync(MANIFEST)) {
      /**
       * Present but invalid is a stop, not a rebuild.
       *
       * The tree on disk disagrees with the manifest that describes it, which
       * means it was modified or partially copied. Payment for that must be an
       * explicit `--rebuild`, not a silent several-minute Docker build that makes
       * the evidence of the corruption disappear.
       */
      verifyExisting()
      return 0
    }
    log('no artifact tree is present')
    buildFresh()
    verifyExisting()
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[prepare-artifacts] FAILED: ${message}\n` +
        '[prepare-artifacts] Packaging stopped: a package without verified artifacts would ' +
        'build, install and start, then fail every WSL Agent session.\n' +
        `[prepare-artifacts] ${BUILD_HINT}\n`
    )
    return 1
  }
}

module.exports = { ARTIFACT_ROOT, RUNTIME_FILES, main }

if (require.main === module) process.exit(main(process.argv.slice(2)))
