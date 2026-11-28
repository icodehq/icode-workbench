'use strict'
/**
 * File-watching acceptance probe.
 *
 * Launches a real Electron window against an isolated profile, creates a shell
 * session on a synthetic monorepo with package-level node_modules/dist, then
 * opens Files and Source Control. It asserts the structural promises of the
 * watcher refactor:
 *   - the main process does not stall while watches are installed,
 *   - Files subscribes to visible folders, not the whole checkout,
 *   - Source Control has a small number of recursive subscriptions,
 *   - killing the watcher child drops both panes to polling and a write is
 *     still visible within the polling window.
 *
 * Manual probe (no CI job): `pnpm perf:watch`. Results land in
 * artifacts/watch-perf/report.json; set ICODE_PERF_REPORT_ONLY=1 to report
 * without failing.
 */

const { spawn } = require('node:child_process')
const {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')
const { connectMain } = require('./lib/main-cdp.cjs')
const { createWatchFixture } = require('./lib/watch-fixture.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const ELECTRON = require('electron')
const ARTIFACT_DIR = join(APP_DIR, 'artifacts', 'watch-perf')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'icode-watch-perf-'))
const REPO_DIR = join(RUN_DIR, 'repo')
const USER_DATA = join(RUN_DIR, 'userdata')
const HOST_DIR = join(RUN_DIR, 'host')
const RENDERER_PORT = 27_100 + (process.pid % 400)
const MAIN_PORT = 28_100 + (process.pid % 400)
const FILE_COUNT = Number(process.env.ICODE_WATCH_PERF_FILES ?? 35_000)
const EXPANDED_PACKAGES = 10

const RUN = {
  startedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  runDir: RUN_DIR,
  scenarios: [],
  failures: []
}

let appProcess = null
let cdp = null
let mainCdp = null
let logStream = null
let watcherChildPid = null

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function log(message) {
  process.stdout.write(`[watch-perf] ${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function prepareRunDir() {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(REPO_DIR, { recursive: true })
  RUN.fixture = createWatchFixture(REPO_DIR, { source: true })
}

async function launch() {
  const logPath = join(ARTIFACT_DIR, 'app.log')
  logStream = createWriteStream(logPath)
  RUN.log = logPath
  /*
   * A probe launched from inside an iCode-hosted terminal inherits that
   * session's ICODE_HOST_* values; they would point this app at the parent's
   * socket and its own profile could not authenticate. Start from a clean
   * namespace and let the isolated profile derive its own endpoint.
   */
  const env = { ...process.env }
  const inheritedHostKeys = new Set([
    'ICODE_HOST_DIR',
    'ICODE_HOST_SOCKET',
    'ICODE_PROFILE_DIR',
    'ICODE_ACTIVITY_SOCKET',
    'ICODE_SESSION_ID',
    'ICODE_SESSION_INCARNATION'
  ])
  for (const key of Object.keys(env)) {
    if (inheritedHostKeys.has(key)) delete env[key]
  }
  Object.assign(env, {
    ICODE_GATE_USER_DATA: USER_DATA,
    ICODE_BACKGROUND_LAUNCH: '0',
    ICODE_HOST_DIR: HOST_DIR,
    ICODE_WATCH_PERF: '1'
  })
  appProcess = spawn(
    ELECTRON,
    [
      `--inspect=${MAIN_PORT}`,
      '.',
      `--remote-debugging-port=${RENDERER_PORT}`,
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ],
    {
      cwd: APP_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  appProcess.stdout.pipe(logStream)
  appProcess.stderr.pipe(logStream)
  cdp = await connect(RENDERER_PORT)
  mainCdp = await connectMain(MAIN_PORT)
  await cdp.send('Page.bringToFront').catch(() => undefined)
  await waitForSelector('[data-testid="workspace-sidebar"]', 30_000)
  await waitFor(
    `Boolean(document.querySelector('[data-testid^="project-row-"]')) || Boolean(document.querySelector('[data-testid="empty-workspace"]'))`,
    'workspace shell',
    30_000
  )
}

async function quitApp() {
  if (mainCdp !== null) {
    try {
      mainCdp.close()
    } catch {}
    mainCdp = null
  }
  if (cdp !== null) {
    try {
      await cdp.evaluate('window.close()')
    } catch {}
  }
  await sleep(1200)
  if (watcherChildPid !== null) {
    try {
      process.kill(watcherChildPid)
    } catch {}
    watcherChildPid = null
  }
  if (appProcess !== null) {
    try {
      appProcess.kill()
    } catch {}
  }
  try {
    const meta = JSON.parse(readFileSync(join(HOST_DIR, 'meta.json'), 'utf8'))
    if (typeof meta.pid === 'number') process.kill(meta.pid)
  } catch {}
  if (cdp !== null) {
    try {
      cdp.close()
    } catch {}
  }
  cdp = null
  appProcess = null
  if (logStream !== null) logStream.end()
  if (process.env.ICODE_KEEP_PERF_RUN !== '1') {
    try {
      rmSync(RUN_DIR, { recursive: true, force: true })
    } catch {}
  }
}

async function waitFor(expression, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression)
      if (last) return last
    } catch (error) {
      last = error.message
    }
    await sleep(150)
  }
  throw new Error(`Timed out waiting for ${description} (last: ${JSON.stringify(last)})`)
}

async function waitForMain(expression, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await mainCdp.evaluate(expression)
      if (last) return last
    } catch (error) {
      last = error.message
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for ${description} (last: ${JSON.stringify(last)})`)
}

async function waitForSelector(selector, timeoutMs = 20_000) {
  return waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, selector, timeoutMs)
}

async function click(selector) {
  const clicked = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`)
  assert(clicked, `Could not click ${selector}`)
}

async function setInput(selector, value) {
  const applied = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  assert(applied, `Could not set ${selector}`)
}

async function setSelect(selector, value) {
  const applied = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value === ${JSON.stringify(value)};
  })()`)
  assert(applied, `Could not select ${value} in ${selector}`)
}

async function registerRepo() {
  await waitForSelector('[data-testid="empty-add-repo"]', 20_000)
  await click('[data-testid="empty-add-repo"]')
  await waitForSelector('[data-testid="add-repo-input"]')
  await setInput('[data-testid="add-repo-input"]', REPO_DIR)
  await click('[data-testid="add-repo-submit"]')
  await waitFor(
    `Boolean(document.querySelector('[data-testid^="project-row-"]'))`,
    'the registered project',
    30_000
  )
  await waitFor(
    `(async () => {
      const result = await window.icode.repos.list();
      return result.ok && result.value.some((repo) =>
        repo.path === ${JSON.stringify(REPO_DIR)} &&
        (repo.preparation === null || repo.preparation?.state === 'ready')
      );
    })()`,
    'the repository to be ready',
    60_000
  )
}

async function createSession(title) {
  await click('[data-testid="sidebar-new-menu"]')
  await waitForSelector('[data-testid="new-session-open"]', 10_000)
  await click('[data-testid="new-session-open"]')
  await waitForSelector('[data-testid="new-session-agent"]', 15_000)
  await setSelect('[data-testid="new-session-agent"]', 'shell')
  await waitFor(
    `!document.querySelector('[data-testid="create-session-submit"]')?.disabled`,
    'an available Harness',
    30_000
  )
  await setInput('[data-testid="session-title-input"]', title)
  await click('[data-testid="create-session-submit"]')
  await waitFor(
    `document.querySelector('[data-testid="session-title"]')?.innerText === ${JSON.stringify(title)}`,
    `session ${title}`,
    20_000
  )
  await waitFor(
    `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === 'live'`,
    `session ${title} live`,
    25_000
  )
  await waitFor(
    `!document.querySelector('[data-testid="new-session-dialog"]')`,
    'the new-session dialog to close',
    15_000
  )
}

async function sessionWorktree(title) {
  return cdp.evaluate(`(async () => {
    const result = await window.icode.sessions.list({});
    if (!result.ok) return null;
    const session = result.value.sessions.find((entry) => entry.title === ${JSON.stringify(title)});
    return session ? { id: session.id, worktreePath: session.worktree?.path ?? null } : null;
  })()`)
}

async function startMainProbe() {
  await mainCdp.evaluate(`(() => {
    const ph = process.getBuiltinModule('perf_hooks');
    if (globalThis.__watchDelay) { globalThis.__watchDelay.reset(); return 'reset'; }
    const delay = ph.monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    globalThis.__watchDelay = delay;
    return 'installed';
  })()`)
}

async function readMainProbe() {
  return mainCdp.evaluate(`(() => {
    const delay = globalThis.__watchDelay;
    return delay === undefined
      ? null
      : { p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 };
  })()`)
}

async function watchStats() {
  return mainCdp.evaluate('globalThis.__icodeWatchStats ? globalThis.__icodeWatchStats() : null')
}

async function expandEntry(path) {
  const selector = `[data-testid="files-entry-${path}"]`
  await waitForSelector(selector, 20_000)
  await click(selector)
}

async function scenarioOpenFiles(worktreePath, sessionId) {
  await startMainProbe()
  await click('[data-testid="view-files"]')
  await waitForSelector('[data-testid="session-inspector"] [data-testid="files-tree"]', 20_000)
  /*
   * The tree is virtualized, so aiming clicks at the tenth package row would
   * require scrolling the probe. The roots are what the perf claim is about:
   * ask the pane for the same set it would derive from ten expanded packages.
   */
  const roots = [
    'packages',
    ...Array.from(
      { length: EXPANDED_PACKAGES },
      (_, index) => `packages/pkg-${String(index).padStart(2, '0')}`
    )
  ]
  await cdp.evaluate(`(async () => {
    const result = await window.icode.files.watch({
      sessionId: ${JSON.stringify(sessionId)},
      active: true,
      roots: ${JSON.stringify(roots)}
    });
    return result.ok && result.value.watching;
  })()`)
  await waitFor(
    `document.querySelector('[data-testid="files-panel"]')?.getAttribute('data-live-mode') === 'watch'`,
    'the Files watcher to become live',
    15_000
  )
  const stats = await waitForMain(
    `(() => {
      const stats = globalThis.__icodeWatchStats?.();
      return stats && stats.watcherChild && stats.watcherChild.watches > 0 ? stats : null;
    })()`,
    'the watcher child statistics',
    15_000
  )
  watcherChildPid = stats.watcherChild.pid ?? null
  await sleep(1_000)
  const probe = await readMainProbe()

  assert(stats.files.activeSessions === 1, 'Files should have one active session')
  assert(
    stats.files.roots >= EXPANDED_PACKAGES + 1,
    `Files roots ${stats.files.roots} < ${String(EXPANDED_PACKAGES + 1)}`
  )
  assert(stats.watcherChild.backend === 'parcel', `backend is ${String(stats.watcherChild.backend)}`)
  assert(
    stats.watcherChild.watches <= 64,
    `child opened ${String(stats.watcherChild.watches)} watches for visible roots`
  )
  assert(probe.max <= 250, `main event loop stalled ${probe.max.toFixed(1)} ms installing watches`)
  assert(probe.p99 <= 100, `main event loop p99 ${probe.p99.toFixed(1)} ms while watching`)

  return {
    worktreePath,
    expanded: EXPANDED_PACKAGES + 1,
    stats,
    probe: { max: Math.round(probe.max * 10) / 10, p99: Math.round(probe.p99 * 10) / 10 }
  }
}

async function scenarioChanges() {
  await click('[data-testid="view-changes"]')
  await waitForSelector('[data-testid="working-tree"]', 20_000)
  await waitFor(
    `document.querySelector('[data-testid="changes-panel"]')?.getAttribute('data-watch-mode') === 'watch'`,
    'the Source Control watcher to become live',
    15_000
  )
  const stats = await waitForMain(
    `(() => {
      const stats = globalThis.__icodeWatchStats?.();
      return stats && stats.watcherChild && stats.watcherChild.subscriptions >= 1 ? stats : null;
    })()`,
    'the Source Control subscription',
    15_000
  )
  // Files and Source Control are mutually exclusive tabs: switching to Changes
  // stops the Files subscription, so this is the Git watch alone.
  assert(
    stats.watcherChild.watches <= 96,
    `recursive Source Control added too many watches (${String(stats.watcherChild.watches)})`
  )
  return { stats }
}

async function scenarioPollFallback(worktreePath) {
  assert(watcherChildPid !== null, 'no watcher child pid to kill')
  process.kill(watcherChildPid)
  watcherChildPid = null
  await click('[data-testid="view-files"]')
  await waitFor(
    `document.querySelector('[data-testid="files-panel"]')?.getAttribute('data-live-mode') === 'poll'`,
    'Files to fall back to polling',
    8_000
  )
  // The checkout root is always listed, so the row can appear without expanding
  // anything the virtualizer may not have rendered.
  writeFileSync(join(worktreePath, 'poll-fallback.txt'), 'polled\n')
  await waitForSelector(
    '[data-testid="session-inspector"] [data-testid="files-entry-poll-fallback.txt"]',
    6_000
  )
  return { polled: true }
}

async function measure(name, work) {
  log(name)
  const startedAt = Date.now()
  try {
    const details = await work()
    RUN.scenarios.push({ name, status: 'passed', durationMs: Date.now() - startedAt, ...details })
    return details
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    RUN.scenarios.push({ name, status: 'failed', durationMs: Date.now() - startedAt, error: message })
    RUN.failures.push(`${name}: ${message}`)
    return null
  }
}

async function main() {
  prepareRunDir()
  await launch()
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(400)

  await registerRepo()
  await createSession('Watch perf')
  const session = await sessionWorktree('Watch perf')
  assert(session?.worktreePath, 'session has no worktree path')

  log(`generating ${String(FILE_COUNT)} generated files under ${session.worktreePath}`)
  RUN.generated = createWatchFixture(session.worktreePath, { source: false, files: FILE_COUNT })

  await measure('open-files', () => scenarioOpenFiles(session.worktreePath, session.id))
  await measure('open-changes', scenarioChanges)
  await measure('poll-fallback', () => scenarioPollFallback(session.worktreePath))

  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
}

main()
  .catch((error) => {
    RUN.failures.push(error instanceof Error ? error.message : String(error))
  })
  .finally(async () => {
    try {
      await quitApp()
    } catch {}
    RUN.finishedAt = new Date().toISOString()
    try {
      writeFileSync(join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(RUN, null, 2)}\n`)
    } catch {}
    log(`report: ${join(ARTIFACT_DIR, 'report.json')}`)
    if (RUN.failures.length > 0) {
      log(`FAILED (${RUN.failures.length}):`)
      for (const failure of RUN.failures) log(` - ${failure}`)
      if (process.env.ICODE_PERF_REPORT_ONLY !== '1') process.exitCode = 1
    } else {
      log('watch acceptance passed')
    }
  })
