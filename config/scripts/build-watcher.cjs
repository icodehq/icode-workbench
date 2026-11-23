'use strict'

/**
 * The watcher child is a self-contained CJS bundle, like the terminal Host.
 * It is launched with the Electron binary under ELECTRON_RUN_AS_NODE, where
 * asar is unavailable, so the entry and everything it requires must be real
 * files in `app.asar.unpacked`.
 *
 * Phase 1 bundles chokidar. Phase 2 keeps @parcel/watcher external so its
 * native prebuild can be resolved from node_modules at runtime.
 */

const path = require('node:path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..', '..')

esbuild
  .build({
    entryPoints: [path.join(root, 'src/watch/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(root, 'out/watch/index.js'),
    external: ['@parcel/watcher'],
    sourcemap: false,
    logLevel: 'info'
  })
  .catch((error) => {
    process.stderr.write(`[icode] watcher build failed: ${String(error)}\n`)
    process.exit(1)
  })
