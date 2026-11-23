'use strict'

/**
 * Shared electron-builder configuration.
 *
 * Platform files spread this object and add only what their target needs. The
 * package dispatcher selects a platform config explicitly, so cross-building for
 * Windows from Linux cannot accidentally inherit another target's resources.
 */

const identity = require('../src/shared/app-identity.json')

module.exports = {
  appId: identity.appId,
  productName: identity.name,
  /**
   * The update feed is explicit rather than inferred from `repository`.
   *
   * electron-builder writes `resources/app-update.yml` (which electron-updater
   * reads) and, for deb/rpm, `resources/package-type` only when a publish
   * configuration resolves. `package.cjs` always passes `--publish never`, so
   * this describes the feed without letting a build upload anything.
   */
  publish: [
    {
      provider: 'github',
      owner: identity.releaseOwner,
      repo: identity.releaseRepo,
      releaseType: 'release'
    }
  ],
  directories: {
    buildResources: 'resources/build',
    output: 'dist'
  },
  files: ['out/**/*', 'package.json'],
  asar: true,
  // Why: the detached host and watcher child are executed by the Electron
  // binary via ELECTRON_RUN_AS_NODE, so they and their native dependencies must
  // exist outside the asar. Parcel's wrapper JS is unpacked too because the
  // "smart unpack" heuristic only unpacks module roots that contain binaries.
  asarUnpack: [
    'out/host/**',
    'out/watch/**',
    'node_modules/node-pty/**',
    'node_modules/@parcel/**',
    'node_modules/detect-libc/**',
    'node_modules/is-glob/**',
    'node_modules/is-extglob/**',
    'node_modules/picomatch/**'
  ],
  // Repair packed node-pty paths/modes before signing and artifacts.
  afterPack: 'config/scripts/native/after-pack.cjs',
  // node-pty is prepared per platform by config/scripts/native; electron-builder
  // must not rebuild it for the host Node ABI.
  npmRebuild: false,
  buildDependenciesFromSource: false
}
