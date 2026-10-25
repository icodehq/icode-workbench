const { existsSync } = require('node:fs')
const { join } = require('node:path')

/**
 * The guest Host tree must exist before packaging.
 *
 * `extraResources` only warns when its source is missing, so a build without the
 * Linux artifacts finished successfully and shipped an installer in which every
 * WSL Agent session failed with "The Linux Host artifacts are missing." Failing
 * here turns a silent broken release into an actionable build error.
 */
const WSL_ARTIFACT_MANIFEST = join(__dirname, '..', 'artifacts', 'wsl-host', 'linux-x64', 'manifest.json')
if (!existsSync(WSL_ARTIFACT_MANIFEST)) {
  throw new Error(
    `Packaging needs the Linux Host artifacts at ${WSL_ARTIFACT_MANIFEST}. ` +
      'Build them with "pnpm build:wsl-host" (Linux + Docker) or package with ' +
      '"pnpm package:win", which prepares them before electron-builder starts. ' +
      'Without them a packaged WSL Agent cannot start.'
  )
}

module.exports = {
  appId: 'dev.ade.app',
  productName: 'ADE',
  directories: {
    output: 'dist'
  },
  files: ['out/**/*', 'package.json'],
  /**
   * The Linux Host tree the managed WSL Host is deployed from.
   *
   * `wslArtifactRoot()` reads `resourcesPath/artifacts/wsl-host/linux-x64` in a
   * packaged app, and the gate build proved why: without this it is absent, so
   * every WSL Agent session failed with "The Linux Host artifacts are missing."
   * It cannot live inside the asar — the guest Host is extracted and executed
   * from real files — hence `extraResources`, next to the unpacked host.
   */
  // The filter drops the build-time download cache only.
  //
  // artifacts/wsl-host/.cache/node-v24.21.0-linux-x64.tar.xz is a 32 MB archive
  // the artifact builder downloads so it does not fetch Node twice. It is not in
  // the manifest and nothing reads it at run time, so shipping it only inflates
  // the installer. The exclusion is deliberately narrow: the catch-all keeps
  // every runtime file, and linux-x64 is what wslArtifactRoot() reads.
  extraResources: [
    {
      from: 'artifacts/wsl-host',
      to: 'artifacts/wsl-host',
      filter: ['**/*', '!**/.cache/**', '!**/.cache']
    }
  ],
  asar: true,
  // Why: the detached host is executed by the Electron binary via ELECTRON_RUN_AS_NODE,
  // so it and its native PTY must exist outside the asar archive.
  asarUnpack: ['out/host/**', 'node_modules/node-pty/**'],
  // Why: node-pty is rebuilt for the Electron ABI by pnpm postinstall/electron-rebuild.
  // electron-builder must not rebuild it for the host Node ABI.
  npmRebuild: false,
  buildDependenciesFromSource: false,
  linux: {
    target: ['dir'],
    executableName: 'ade',
    category: 'Development'
  }
}
