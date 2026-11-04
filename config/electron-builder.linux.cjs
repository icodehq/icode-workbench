'use strict'

const identity = require('../src/shared/app-identity.json')
const base = require('./electron-builder.base.cjs')

/**
 * Linux packaging.
 *
 * The app's own node-pty is staged by config/scripts/native at the glibc 2.35
 * baseline; only `build/Release` is shipped. The WSL guest tree is Windows-only
 * and is deliberately absent here.
 */
module.exports = {
  ...base,
  linux: {
    target: ['AppImage', 'deb', 'rpm'],
    executableName: identity.executableName,
    category: 'Development',
    icon: 'resources/build/icons',
    maintainer: 'iCode contributors <icode-maintainers@users.noreply.github.com>',
    synopsis: 'Agent development environment',
    description: 'iCode is an agent development environment for local coding agent TUIs.',
    artifactName: '${productName}-${version}-linux-${arch}.${ext}',
    /**
     * The pinned glibc build is the payload. Prebuilds from another platform and
     * Electron-ABI copies would only add foreign binaries.
     */
    files: [
      'out/**/*',
      'package.json',
      '!node_modules/node-pty/prebuilds/**',
      '!node_modules/node-pty/bin/**'
    ]
  }
}
