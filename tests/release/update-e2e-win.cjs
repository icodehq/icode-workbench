'use strict'

/**
 * Windows packaged-update end-to-end check.
 *
 * Installs a deliberately old build, serves the new installer through a local
 * generic feed, arms the app's E2E hook, and waits for the relaunched build to
 * report its version. This is the only test that exercises the real NSIS
 * installer, process exit and relaunch; the unit suite mocks electron-updater.
 *
 * Run on a Windows runner (or a disposable Windows VM):
 *
 *   node tests/release/update-e2e-win.cjs \
 *     --old-installer dist/iCode-0.0.1-setup-x64.exe \
 *     --new-installer release-assets/windows/iCode-0.24.0-setup-x64.exe
 *
 * `latest.yml` is read next to the new installer. The old build must advertise
 * a lower version; the CI workflow builds it with package.json set to 0.0.1.
 */

const { spawn, spawnSync } = require('node:child_process')
const { createServer } = require('node:http')
const {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')

function log(message) {
  process.stdout.write(`[update-e2e] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[update-e2e] FAIL ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {
    oldInstaller: null,
    oldVersion: '0.0.1',
    newInstaller: null,
    newVersion: null,
    installDir: 'C:\\icode-update-e2e',
    timeoutMs: 5 * 60_000,
    keep: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--old-installer') options.oldInstaller = resolve(argv[++index])
    else if (arg === '--old-version') options.oldVersion = argv[++index]
    else if (arg === '--new-installer') options.newInstaller = resolve(argv[++index])
    else if (arg === '--new-version') options.newVersion = argv[++index]
    else if (arg === '--install-dir') options.installDir = argv[++index]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index])
    else if (arg === '--keep') options.keep = true
    else fail(`unknown argument: ${arg}`)
  }
  if (options.oldInstaller === null) fail('--old-installer is required')
  if (options.newInstaller === null) fail('--new-installer is required')
  if (!existsSync(options.oldInstaller)) fail(`old installer not found: ${options.oldInstaller}`)
  if (!existsSync(options.newInstaller)) fail(`new installer not found: ${options.newInstaller}`)
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    fail('--timeout-ms must be a positive number')
  }
  return options
}

function metadataFor(installer) {
  const path = join(dirname(installer), 'latest.yml')
  if (!existsSync(path)) fail(`latest.yml not found next to ${installer}`)
  return { path, text: readFileSync(path, 'utf8') }
}

function versionFromMetadata(text) {
  const match = /^version:\s*(\S+)\s*$/mu.exec(text)
  if (match === null) fail('latest.yml has no version')
  return match[1]
}

function killApp() {
  spawnSync('taskkill', ['/IM', 'icode.exe', '/T', '/F'], { windowsHide: true })
}

function registryVersion() {
  const script =
    "$entry = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' " +
    "-ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'iCode*' } | " +
    'Select-Object -First 1; if ($entry) { $entry.DisplayVersion }'
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) return ''
  return result.stdout.trim()
}

function waitFor(condition, timeoutMs, intervalMs = 1_000) {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      try {
        if (condition()) {
          resolvePromise(true)
          return
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out after ${timeoutMs}ms`))
        return
      }
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

function contentType(path) {
  if (path.endsWith('.yml')) return 'application/x-yaml'
  if (path.endsWith('.exe')) return 'application/octet-stream'
  return 'application/octet-stream'
}

function serveFeed(directory) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((request, response) => {
      const name = basename(decodeURIComponent((request.url ?? '/').split('?')[0]))
      const file = join(directory, name)
      if (!existsSync(file) || !statSync(file).isFile()) {
        response.writeHead(404)
        response.end('not found')
        return
      }
      const total = statSync(file).size
      const range = request.headers.range
      if (typeof range === 'string') {
        const match = /^bytes=(\d+)-(\d*)$/u.exec(range)
        if (match === null) {
          response.writeHead(416, { 'content-range': `bytes */${total}` })
          response.end()
          return
        }
        const start = Number(match[1])
        const end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1)
        if (start > end || start >= total) {
          response.writeHead(416, { 'content-range': `bytes */${total}` })
          response.end()
          return
        }
        response.writeHead(206, {
          'content-type': contentType(file),
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes'
        })
        createReadStream(file, { start, end }).pipe(response)
        return
      }
      response.writeHead(200, {
        'content-type': contentType(file),
        'content-length': total,
        'accept-ranges': 'bytes'
      })
      createReadStream(file).pipe(response)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise(server))
  })
}

function addressPort(server) {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('the local update feed did not bind a TCP port')
  }
  return address.port
}

function updateLogPath() {
  return join(process.env.APPDATA ?? '', 'iCode', 'logs', 'update.log')
}

function dumpDiagnostics(resultFile) {
  if (existsSync(updateLogPath())) {
    log('--- update.log ---')
    process.stderr.write(readFileSync(updateLogPath(), 'utf8'))
    log('--- end update.log ---')
  } else {
    log(`no update log at ${updateLogPath()}`)
  }
  if (existsSync(resultFile)) {
    log(`result file: ${readFileSync(resultFile, 'utf8')}`)
  }
}

async function main() {
  if (process.platform !== 'win32') {
    fail('this end-to-end check runs on Windows only')
  }
  const options = parseArgs(process.argv.slice(2))
  const metadata = metadataFor(options.newInstaller)
  const newVersion = options.newVersion ?? versionFromMetadata(metadata.text)
  if (newVersion === options.oldVersion) {
    fail('the new installer must have a higher version than the old one')
  }

  const feedDirectory = mkdtempSync(join(tmpdir(), 'icode-update-feed-'))
  const resultFile = join(feedDirectory, 'result.txt')
  const newInstallerName = basename(options.newInstaller)
  copyFileSync(options.newInstaller, join(feedDirectory, newInstallerName))
  copyFileSync(metadata.path, join(feedDirectory, 'latest.yml'))
  log(`feed ${newVersion}: ${newInstallerName}`)

  killApp()
  rmSync(options.installDir, { recursive: true, force: true })
  const installParent = dirname(options.installDir)
  if (!existsSync(installParent)) mkdirSync(installParent, { recursive: true })

  log(`installing old build ${options.oldVersion} into ${options.installDir}`)
  const install = spawnSync(
    options.oldInstaller,
    ['/S', '/currentuser', `/D=${options.installDir}`],
    { windowsHide: true, timeout: 10 * 60_000 }
  )
  if (install.error) fail(String(install.error))
  if (install.status !== 0) fail(`old installer exited with ${String(install.status)}`)
  await waitFor(() => registryVersion() === options.oldVersion, 60_000)
  killApp()

  const server = await serveFeed(feedDirectory)
  const port = addressPort(server)
  log(`local feed http://127.0.0.1:${port}/`)

  const appExe = join(options.installDir, 'icode.exe')
  if (!existsSync(appExe)) fail(`the old install has no ${appExe}`)

  const child = spawn(appExe, [], {
    env: {
      ...process.env,
      ICODE_UPDATE_FEED_BASE_URL: `http://127.0.0.1:${port}/`,
      ICODE_UPDATE_E2E: '1',
      ICODE_UPDATE_E2E_TARGET: newVersion,
      ICODE_UPDATE_E2E_RESULT: resultFile,
      ICODE_UPDATE_E2E_DELAY_MS: '15000'
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  log(`started ${appExe} (pid ${String(child.pid ?? '?')})`)

  try {
    await waitFor(
      () => {
        if (existsSync(resultFile)) {
          const value = readFileSync(resultFile, 'utf8').trim()
          if (value === newVersion) return true
          if (value.startsWith('error:')) throw new Error(`E2E app reported: ${value}`)
        }
        return registryVersion() === newVersion
      },
      options.timeoutMs,
      2_000
    )
    log(`PASS installed and relaunched ${newVersion}`)
  } catch (error) {
    dumpDiagnostics(resultFile)
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    killApp()
    server.close()
    if (!options.keep) rmSync(feedDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error))
})
