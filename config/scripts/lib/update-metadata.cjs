'use strict'

/**
 * Validates electron-builder's update metadata and merges the two macOS
 * `latest-mac.yml` files into the single channel file GitHub can host.
 *
 * The release job has no build dependencies beyond production `node_modules`;
 * `yaml` is already a runtime dependency of the app.
 */

const { createHash } = require('node:crypto')
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')
const YAML = require('yaml')

function fail(message) {
  throw new Error(message)
}

function check(condition, message) {
  if (!condition) fail(message)
}

function parseYamlFile(path) {
  check(existsSync(path), `missing metadata file: ${path}`)
  let parsed
  try {
    parsed = YAML.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`invalid YAML in ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  check(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    `metadata is not an object: ${path}`
  )
  check(typeof parsed.version === 'string', `metadata has no version: ${path}`)
  check(Array.isArray(parsed.files) && parsed.files.length > 0, `metadata has no files: ${path}`)
  return parsed
}

function sha512Base64(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

function artifactPath(metadataPath, url) {
  const directory = dirname(metadataPath)
  const path = resolve(directory, url)
  const inside = relative(directory, path)
  check(
    inside !== '' && !inside.startsWith('..') && !inside.startsWith(sep) && !isAbsolute(inside),
    `unsafe asset URL: ${url}`
  )
  return path
}

/**
 * Verifies every file the metadata references, including the blockmaps
 * electron-updater uses for differential downloads.
 */
function verifyMetadata(input) {
  const { path, expectedVersion, platform, macArch = null, verifyArtifacts = true } = input
  const metadata = parseYamlFile(path)
  check(
    metadata.version === expectedVersion,
    `${path} reports ${metadata.version}, expected ${expectedVersion}`
  )
  if (metadata.stagingPercentage !== undefined) {
    fail(`${path} declares stagingPercentage, which this release process does not support`)
  }

  if (macArch !== null) {
    const matching = metadata.files.filter((entry) =>
      typeof entry?.url === 'string' && entry.url.includes(`-mac-${macArch}.zip`)
    )
    check(
      matching.length === 1,
      `${path} must reference exactly one -mac-${macArch}.zip, found ${matching.length}`
    )
  }

  for (const entry of metadata.files) {
    check(typeof entry === 'object' && entry !== null, `${path} has a malformed file entry`)
    check(typeof entry.url === 'string' && entry.url.length > 0, `${path} has a file without a URL`)
    check(typeof entry.sha512 === 'string' && entry.sha512.length > 0, `${path}: ${entry.url} has no sha512`)
    check(Number.isInteger(entry.size) && entry.size >= 0, `${path}: ${entry.url} has no size`)

    if (!verifyArtifacts) continue
    const filePath = artifactPath(path, entry.url)
    check(existsSync(filePath), `metadata references a missing file: ${filePath}`)
    const size = statSync(filePath).size
    check(size === entry.size, `${filePath} is ${size} bytes, metadata says ${entry.size}`)
    check(
      sha512Base64(filePath) === entry.sha512,
      `${filePath} does not match the metadata sha512`
    )

    const needsBlockmap =
      platform === 'win' || (platform === 'mac' && entry.url.endsWith('.zip'))
    if (needsBlockmap) {
      const blockmap = `${filePath}.blockmap`
      check(existsSync(blockmap), `metadata file has no blockmap: ${blockmap}`)
      if (Number.isInteger(entry.blockMapSize)) {
        check(
          statSync(blockmap).size === entry.blockMapSize,
          `${blockmap} size does not match blockMapSize`
        )
      }
    }
  }

  return { path, directory: dirname(path), metadata }
}

function macAsset(metadata, arch) {
  const entry = metadata.files.find((file) => file.url.includes(`-mac-${arch}.zip`))
  check(entry !== undefined, `metadata has no -mac-${arch}.zip`)
  return entry
}

/**
 * Combines the per-arch metadata. Both zips stay in `files`; electron-updater
 * picks the arm64 asset on Apple Silicon and rejects it on x64.
 */
function mergeMacMetadata(input) {
  const { x64Path, arm64Path, expectedVersion } = input
  const x64 = verifyMetadata({ path: x64Path, expectedVersion, platform: 'mac', macArch: 'x64' })
  const arm64 = verifyMetadata({
    path: arm64Path,
    expectedVersion,
    platform: 'mac',
    macArch: 'arm64'
  })
  check(
    x64.metadata.version === arm64.metadata.version,
    'the x64 and arm64 metadata disagree on the version'
  )
  check(
    x64.metadata.stagingPercentage === undefined && arm64.metadata.stagingPercentage === undefined,
    'staged rollouts are not supported for macOS metadata'
  )

  const x64Asset = macAsset(x64.metadata, 'x64')
  macAsset(arm64.metadata, 'arm64')

  const seen = new Set()
  const files = []
  for (const entry of [...x64.metadata.files, ...arm64.metadata.files]) {
    check(!seen.has(entry.url), `duplicate mac asset in merged metadata: ${entry.url}`)
    seen.add(entry.url)
    files.push(entry)
  }

  // Keep the x64 entry as the legacy top-level `path`/`sha512`.
  const merged = {
    ...x64.metadata,
    files
  }
  if (x64.metadata.path !== undefined) merged.path = x64.metadata.path
  if (x64Asset.sha512 !== undefined) merged.sha512 = x64Asset.sha512
  if (
    typeof x64.metadata.releaseDate === 'string' &&
    typeof arm64.metadata.releaseDate === 'string' &&
    arm64.metadata.releaseDate > x64.metadata.releaseDate
  ) {
    merged.releaseDate = arm64.metadata.releaseDate
  }

  const text = YAML.stringify(merged)
  return { metadata: merged, text }
}

function assembleUpdateMetadata(input) {
  const { root, output, expectedVersion } = input
  const windowsYml = join(root, 'windows', 'latest.yml')
  const linuxYml = join(root, 'linux', 'latest-linux.yml')
  const macX64Yml = join(root, 'macos-x64', 'latest-mac.yml')
  const macArm64Yml = join(root, 'macos-arm64', 'latest-mac.yml')

  verifyMetadata({ path: windowsYml, expectedVersion, platform: 'win' })
  verifyMetadata({ path: linuxYml, expectedVersion, platform: 'linux' })
  const mac = mergeMacMetadata({
    x64Path: macX64Yml,
    arm64Path: macArm64Yml,
    expectedVersion
  })

  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })

  copyFileSync(windowsYml, join(output, 'latest.yml'))
  copyFileSync(linuxYml, join(output, 'latest-linux.yml'))
  const mergedPath = join(output, 'latest-mac.yml')
  writeFileSync(mergedPath, mac.text, 'utf8')

  // Re-read the written file so a serializer problem cannot slip through.
  const written = verifyMetadata({
    path: mergedPath,
    expectedVersion,
    platform: 'mac',
    // The metadata directory intentionally holds only channel files; the
    // installers live in the release's asset list, not beside this copy.
    verifyArtifacts: false
  })
  for (const arch of ['x64', 'arm64']) macAsset(written.metadata, arch)

  return {
    output,
    windows: windowsYml,
    linux: linuxYml,
    mac: mergedPath,
    macFiles: written.metadata.files.length
  }
}

module.exports = {
  assembleUpdateMetadata,
  mergeMacMetadata,
  parseYamlFile,
  sha512Base64,
  verifyMetadata
}
