'use strict'
/**
 * Synthetic monorepo for the watch perf probe.
 *
 * The shape is what matters: package-level dependency and build directories,
 * not a root-level `node_modules`. That is the layout that defeated the old
 * first-segment ignore check and the per-file chokidar watch on Windows.
 */

const { execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const DEFAULT_FILES = 35_000
const DEFAULT_PACKAGES = 24
const FILES_PER_PACKAGE_SRC = 6

function write(path, text) {
  writeFileSync(path, text)
}

function createTrackedSource(root, packages) {
  mkdirSync(join(root, 'packages'), { recursive: true })
  write(
    join(root, '.gitignore'),
    ['node_modules/', 'dist/', 'out/', '.next/', '.cache/', '.turbo/', ''].join('\n')
  )
  write(join(root, 'README.md'), '# watch perf fixture\n')
  write(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  for (let index = 0; index < packages; index += 1) {
    const name = `pkg-${String(index).padStart(2, '0')}`
    const directory = join(root, 'packages', name, 'src')
    mkdirSync(directory, { recursive: true })
    for (let file = 0; file < FILES_PER_PACKAGE_SRC; file += 1) {
      write(join(directory, `mod-${String(file)}.ts`), `export const value${String(file)} = ${String(file)}\n`)
    }
    write(join(root, 'packages', name, 'package.json'), `{ "name": "${name}", "private": true }\n`)
  }
}

function createGeneratedTree(root, packages, totalFiles) {
  let written = 0
  let packageIndex = 0
  while (written < totalFiles) {
    const name = `pkg-${String(packageIndex % packages).padStart(2, '0')}`
    const packageRoot = join(root, 'packages', name)
    const dependency = join(packageRoot, 'node_modules', `dep-${String(written % 40)}`)
    mkdirSync(dependency, { recursive: true })
    write(join(dependency, 'index.js'), 'module.exports = 1\n')
    written += 1
    const dist = join(packageRoot, 'dist')
    mkdirSync(dist, { recursive: true })
    write(join(dist, `chunk-${String(written)}.js`), '// generated\n')
    written += 1
    packageIndex += 1
  }
  return written
}

function createWatchFixture(root, options = {}) {
  const packages = options.packages ?? DEFAULT_PACKAGES
  const totalFiles = options.files ?? DEFAULT_FILES
  if (options.source === true) {
    createTrackedSource(root, packages)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync(
      'git',
      ['-c', 'user.email=icode@example.test', '-c', 'user.name=iCode', 'commit', '-qm', 'fixture'],
      { cwd: root }
    )
  }
  const generated = createGeneratedTree(root, packages, totalFiles)
  return { packages, generatedFiles: generated, trackedSource: packages * FILES_PER_PACKAGE_SRC }
}

module.exports = { createWatchFixture }
