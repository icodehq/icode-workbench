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
  directories: {
    buildResources: 'resources/build',
    output: 'dist'
  },
  files: ['out/**/*', 'package.json'],
  // Why: the detached host is executed by the Electron binary via
  // ELECTRON_RUN_AS_NODE, so it and its native PTY must exist outside the asar.
  asar: true,
  asarUnpack: ['out/host/**', 'node_modules/node-pty/**'],
  // Repair packed node-pty paths/modes before signing and artifacts.
  afterPack: 'config/scripts/native/after-pack.cjs',
  // node-pty is prepared per platform by config/scripts/native; electron-builder
  // must not rebuild it for the host Node ABI.
  npmRebuild: false,
  buildDependenciesFromSource: false
}
