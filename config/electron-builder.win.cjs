'use strict'

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const identity = require('../src/shared/app-identity.json')
const base = require('./electron-builder.base.cjs')

/**
 * The guest Host tree must exist before Windows packaging.
 *
 * `extraResources` only warns when its source is missing, so a build without the
 * Linux artifacts can finish successfully and ship an installer in which every
 * WSL Agent session fails at startup. Failing here turns that into an actionable
 * build error. This check belongs to the Windows config only: Linux and macOS
 * builds neither need nor ship the WSL tree.
 */
const WSL_ARTIFACT_MANIFEST = join(__dirname, '..', 'artifacts', 'wsl-host', 'linux-x64', 'manifest.json')
if (!existsSync(WSL_ARTIFACT_MANIFEST)) {
  throw new Error(
    `Windows packaging needs the Linux Host artifacts at ${WSL_ARTIFACT_MANIFEST}. ` +
      'Build them with "pnpm build:wsl-host" on Linux with Docker, or download the ' +
      'verified linux-x64 artifact tree from CI. Without it a packaged WSL Agent ' +
      'cannot start.'
  )
}

module.exports = {
  ...base,
  /**
   * The Linux Host tree the managed WSL Host is deployed from.
   *
   * `wslArtifactRoot()` reads `resourcesPath/artifacts/wsl-host/linux-x64` in a
   * packaged app. It cannot live inside the asar: the guest Host is extracted
   * and executed from real files. The filter drops the build-time download cache
   * only; the catch-all keeps every runtime file.
   */
  extraResources: [
    {
      from: 'artifacts/wsl-host',
      to: 'artifacts/wsl-host',
      filter: ['**/*', '!**/.cache/**', '!**/.cache']
    }
  ],
  win: {
    target: ['nsis'],
    executableName: identity.executableName,
    /**
     * The installer icon is also the shortcut icon. The mark is the app's own
     * (a terminal prompt on the product's dark tile).
     */
    icon: 'resources/build/icon.ico',
    /**
     * A Windows package must not carry a host-built or foreign native module.
     *
     * node-pty's loader tries `build/Release` before `prebuilds/win32-x64`, and
     * `@electron/rebuild` also writes `bin/<platform>-<arch>-<abi>` copies. A
     * pnpm install under WSL leaves ELF files in both places. Excluding them
     * makes the Windows prebuild the only possible choice.
     */
    files: [
      'out/**/*',
      'package.json',
      '!node_modules/node-pty/build/**',
      '!node_modules/node-pty/bin/**'
    ]
  },
  nsis: {
    /** Per-user install: no elevation and no administrator rights. */
    perMachine: false,
    /** Assisted UI: the user can change the install location. */
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: identity.name,
    runAfterFinish: true,
    artifactName: '${productName}-${version}-setup-${arch}.${ext}'
  }
}
