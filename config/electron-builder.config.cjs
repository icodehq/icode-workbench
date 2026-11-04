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
  },

  /**
   * Windows identity and the MSI target.
   *
   * `author` in package.json ("ADE contributors", the copyright holder in
   * LICENSE) is what the MSI records as manufacturer, so the installer names
   * the same publisher the project's own license does.
   */
  win: {
    target: ['msi'],
    /**
     * The shortcut icon is also the MSI's ARPPRODUCTICON, and WiX refuses to
     * link a shortcut that names an Icon element with no file behind it. The
     * mark is the app's own (a terminal prompt on the product's dark tile), not
     * an inherited Electron icon.
     */
    icon: 'build/icon.ico',
    /**
     * A Windows package must not carry a Linux native build.
     *
     * node-pty's loader tries `build/Release` before `prebuilds/win32-x64`, so a
     * pnpm install performed under WSL leaves an ELF `pty.node` inside the
     * archive that Windows attempts and fails to load on every PTY creation
     * before falling back. Excluding it ships only the Windows prebuild; the
     * failure then cannot happen at all.
     */
    files: ['out/**/*', 'package.json', '!node_modules/node-pty/build/**']
  },

  msi: {
    /**
     * Per-user install.
     *
     * The default is already per-user (ALLUSERS=2), stated here so it is a
     * decision rather than an accident: no elevation is required, the program
     * lands under the user's own AppData, and nothing needs administrator rights
     * to install, upgrade or remove.
     */
    perMachine: false,
    /** Assisted UI: the user sees and can change the install location. */
    oneClick: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'ADE',
    runAfterFinish: true
  }
}
