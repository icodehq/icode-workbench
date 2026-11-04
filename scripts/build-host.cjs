'use strict'

/**
 * The detached host is a self-contained CJS bundle. node-pty stays external so
 * the host loads the Electron-ABI build from node_modules.
 */

const path = require('node:path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')

esbuild
  .build({
    entryPoints: [path.join(root, 'src/host/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(root, 'out/host/index.js'),
    external: ['node-pty'],
    sourcemap: false,
    logLevel: 'info'
  })
  .catch((error) => {
    process.stderr.write(`[icode] host build failed: ${String(error)}\n`)
    process.exit(1)
  })
