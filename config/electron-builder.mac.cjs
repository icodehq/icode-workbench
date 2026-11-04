'use strict'

const base = require('./electron-builder.base.cjs')

/**
 * macOS packaging.
 *
 * Separate x64 and arm64 artifacts are built by passing `--x64` or `--arm64`;
 * there is no universal binary. Signing and notarization use the standard
 * electron-builder environment variables (CSC_*, APPLE_*). When they are absent,
 * electron-builder logs that signing/notarization was skipped and still produces
 * an unsigned development artifact.
 */
module.exports = {
  ...base,
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    icon: 'resources/build/icon.icns',
    hardenedRuntime: true,
    entitlements: 'resources/build/entitlements.mac.plist',
    entitlementsInherit: 'resources/build/entitlements.mac.inherit.plist',
    gatekeeperAssess: false,
    minimumSystemVersion: '12.0',
    notarize: true,
    artifactName: '${productName}-${version}-mac-${arch}.${ext}',
    /**
     * The darwin prebuilds are the payload. Excluding `build/**` and `bin/**`
     * prevents a host-arch rebuild or an Electron-ABI copy from shadowing them.
     */
    files: [
      'out/**/*',
      'package.json',
      '!node_modules/node-pty/build/**',
      '!node_modules/node-pty/bin/**'
    ]
  }
}
