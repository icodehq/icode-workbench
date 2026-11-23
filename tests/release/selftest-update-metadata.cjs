'use strict'

/**
 * Exercises the release metadata merger with disposable files.
 *
 * Run with `pnpm selftest:update-metadata`. The real release job uses the same
 * library; this suite covers the failure paths that would otherwise ship a
 * partial or inconsistent update.
 */

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  assembleUpdateMetadata,
  parseYamlFile,
  verifyMetadata
} = require('../../config/scripts/lib/update-metadata.cjs')

const VERSION = '0.18.0'

function writeArtifact(directory, name, content) {
  const path = join(directory, name)
  writeFileSync(path, content)
  return {
    url: name,
    sha512: createHash('sha512').update(content).digest('base64'),
    size: Buffer.byteLength(content)
  }
}

function writeMetadata(path, entries, extra = {}) {
  const metadata = {
    version: VERSION,
    files: entries,
    path: entries[0].url,
    sha512: entries[0].sha512,
    releaseDate: '2026-11-23T00:00:00.000Z',
    ...extra
  }
  writeFileSync(path, JSON.stringify(metadata, null, 2))
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'icode-update-metadata-'))
  const dirs = {
    windows: join(root, 'windows'),
    linux: join(root, 'linux'),
    macosX64: join(root, 'macos-x64'),
    macosArm64: join(root, 'macos-arm64')
  }
  for (const directory of Object.values(dirs)) mkdirSync(directory, { recursive: true })

  const winEntry = writeArtifact(dirs.windows, `iCode-${VERSION}-setup-x64.exe`, 'windows installer')
  writeArtifact(dirs.windows, `${winEntry.url}.blockmap`, 'windows blockmap')
  writeMetadata(join(dirs.windows, 'latest.yml'), [winEntry])

  const linuxEntry = writeArtifact(dirs.linux, `iCode-${VERSION}-linux-x64.AppImage`, 'appimage')
  writeMetadata(join(dirs.linux, 'latest-linux.yml'), [linuxEntry])

  const macX64 = writeArtifact(dirs.macosX64, `iCode-${VERSION}-mac-x64.zip`, 'mac x64')
  writeArtifact(dirs.macosX64, `${macX64.url}.blockmap`, 'mac x64 blockmap')
  writeMetadata(join(dirs.macosX64, 'latest-mac.yml'), [macX64])

  const macArm64 = writeArtifact(dirs.macosArm64, `iCode-${VERSION}-mac-arm64.zip`, 'mac arm64')
  writeArtifact(dirs.macosArm64, `${macArm64.url}.blockmap`, 'mac arm64 blockmap')
  writeMetadata(join(dirs.macosArm64, 'latest-mac.yml'), [macArm64])

  return { root, dirs, winEntry, linuxEntry, macX64, macArm64 }
}

function withFixture(run) {
  const data = fixture()
  try {
    run(data)
  } finally {
    rmSync(data.root, { recursive: true, force: true })
  }
}

function test(name, run) {
  try {
    run()
    process.stdout.write(`ok ${name}\n`)
  } catch (error) {
    process.stderr.write(`not ok ${name}\n${error instanceof Error ? error.stack : error}\n`)
    process.exitCode = 1
    throw error
  }
}

test('merges both macOS zips and copies the other channel files', () => {
  withFixture((data) => {
    const output = join(data.root, 'metadata')
    const result = assembleUpdateMetadata({
      root: data.root,
      output,
      expectedVersion: VERSION
    })
    assert.equal(result.macFiles, 2)
    for (const name of ['latest.yml', 'latest-linux.yml', 'latest-mac.yml']) {
      assert.ok(existsSync(join(output, name)), `${name} was not written`)
    }
    const merged = parseYamlFile(join(output, 'latest-mac.yml'))
    assert.deepEqual(
      merged.files.map((entry) => entry.url),
      [data.macX64.url, data.macArm64.url]
    )
    assert.equal(merged.version, VERSION)
    assert.equal(merged.path, data.macX64.url)
    assert.equal(merged.sha512, data.macX64.sha512)
  })
})

test('rejects a metadata version that differs from the release', () => {
  withFixture((data) => {
    assert.throws(
      () =>
        verifyMetadata({
          path: join(data.dirs.windows, 'latest.yml'),
          expectedVersion: '0.18.1',
          platform: 'win'
        }),
      /expected 0.18.1/u
    )
  })
})

test('rejects a macOS file without its architecture zip', () => {
  withFixture((data) => {
    const path = join(data.dirs.macosArm64, 'latest-mac.yml')
    writeMetadata(path, [data.macX64])
    assert.throws(
      () => verifyMetadata({ path, expectedVersion: VERSION, platform: 'mac', macArch: 'arm64' }),
      /exactly one -mac-arm64\.zip/u
    )
  })
})

test('rejects a missing blockmap', () => {
  withFixture((data) => {
    unlinkSync(join(data.dirs.macosX64, `${data.macX64.url}.blockmap`))
    assert.throws(
      () =>
        verifyMetadata({
          path: join(data.dirs.macosX64, 'latest-mac.yml'),
          expectedVersion: VERSION,
          platform: 'mac',
          macArch: 'x64'
        }),
      /no blockmap/u
    )
  })
})

test('rejects a SHA-512 or size mismatch', () => {
  withFixture((data) => {
    const path = join(data.dirs.windows, 'latest.yml')
    const metadata = JSON.parse(readFileSync(path, 'utf8'))
    metadata.files[0].sha512 = 'AAAA'
    writeFileSync(path, JSON.stringify(metadata))
    assert.throws(
      () => verifyMetadata({ path, expectedVersion: VERSION, platform: 'win' }),
      /sha512/u
    )

    metadata.files[0].sha512 = data.winEntry.sha512
    metadata.files[0].size += 1
    writeFileSync(path, JSON.stringify(metadata))
    assert.throws(
      () => verifyMetadata({ path, expectedVersion: VERSION, platform: 'win' }),
      /metadata says/u
    )
  })
})

test('rejects a referenced file that is absent', () => {
  withFixture((data) => {
    unlinkSync(join(data.dirs.linux, data.linuxEntry.url))
    assert.throws(
      () =>
        verifyMetadata({
          path: join(data.dirs.linux, 'latest-linux.yml'),
          expectedVersion: VERSION,
          platform: 'linux'
        }),
      /missing file/u
    )
  })
})

test('rejects staged-rollout metadata', () => {
  withFixture((data) => {
    const path = join(data.dirs.windows, 'latest.yml')
    const metadata = JSON.parse(readFileSync(path, 'utf8'))
    metadata.stagingPercentage = 10
    writeFileSync(path, JSON.stringify(metadata))
    assert.throws(
      () => verifyMetadata({ path, expectedVersion: VERSION, platform: 'win' }),
      /stagingPercentage/u
    )
  })
})

test('rejects a mac merge with duplicate assets', () => {
  withFixture((data) => {
    const x64Path = join(data.dirs.macosX64, 'latest-mac.yml')
    const arm64Path = join(data.dirs.macosArm64, 'latest-mac.yml')
    const arm64 = JSON.parse(readFileSync(arm64Path, 'utf8'))
    arm64.files.push(arm64.files[0])
    writeFileSync(arm64Path, JSON.stringify(arm64))
    assert.throws(
      () =>
        assembleUpdateMetadata({
          root: data.root,
          output: join(data.root, 'metadata'),
          expectedVersion: VERSION
        }),
      /exactly one -mac-arm64\.zip/u
    )
  })
})

if (process.exitCode !== undefined) process.exit(process.exitCode)
process.stdout.write('update metadata selftest passed\n')
