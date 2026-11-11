'use strict'
/**
 * Real-Electron acceptance smoke for instant project removal.
 *
 * Covers the two cases that unit tests cannot prove through the real stack:
 *   1. removing a project while a PTY is live (auto-stop + dirty snapshot),
 *   2. removing while the Host is unreachable, then retrying after it returns.
 *
 * The terminal Host is deliberately detached, as in production.
 */
const { spawn, execFileSync } = require('node:child_process')
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const ELECTRON = require('electron')
const ARTIFACT_DIR = join(APP_DIR, 'artifacts', 'removal-smoke')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'icode-removal-smoke-'))
const REPO1 = join(RUN_DIR, 'repo-one')
const REPO2 = join(RUN_DIR, 'repo-two')
const USER_DATA = join(RUN_DIR, 'userdata')
const HOST_DIR = join(RUN_DIR, 'host')
const SOCKET = join(HOST_DIR, 'terminal-host.sock')
const BROKEN_DIR = join(RUN_DIR, 'broken-host')

const RUN = {
  startedAt: new Date().toISOString(),
  runDir: RUN_DIR,
  steps: [],
  failures: [],
  artifacts: []
}

let appProcess = null
let cdp = null
let nextPort = 9900 + (process.pid % 200)

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function log(message) {
  process.stdout.write(`[removal-smoke] ${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function step(name, work) {
  const startedAt = Date.now()
  log(name)
  try {
    const details = await work()
    RUN.steps.push({
      name,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      ...(details === undefined ? {} : { details })
    })
    return details
  } catch (error) {
    RUN.steps.push({
      name,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    RUN.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

async function screenshot(name) {
  if (!cdp) return
  const path = join(ARTIFACT_DIR, `${name}.png`)
  try {
    await cdp.screenshot(path)
    RUN.artifacts.push(path)
  } catch (error) {
    RUN.artifacts.push(`${path} (failed: ${error.message})`)
  }
}

async function waitFor(expression, description, timeoutMs = 15000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression)
      if (last) return last
    } catch (error) {
      last = error.message
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${description} (last: ${JSON.stringify(last)})`)
}

async function waitForSelector(selector, timeoutMs = 15000) {
  return waitFor(
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    selector,
    timeoutMs
  )
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
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return element.value === ${JSON.stringify(value)};
  })()`)
  assert(applied, `Could not set ${selector}`)
}

async function bodyText() {
  return cdp.evaluate('document.body.innerText')
}

async function sessions() {
  return cdp.evaluate(`(() => {
    const byId = new Map();
    for (const element of document.querySelectorAll('[data-session-id]')) {
      const id = element.dataset.sessionId;
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        state: element.dataset.sessionState,
        text: element.innerText
      });
    }
    return Array.from(byId.values());
  })()`)
}

function gitRefs(repoPath, prefix) {
  return execFileSync('git', ['-C', repoPath, 'for-each-ref', prefix], {
    stdio: 'pipe'
  }).toString('utf8')
}

async function waitForPathGone(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(path)) return
    await sleep(100)
  }
  throw new Error(`Path still exists after removal: ${path}`)
}


/** The detached Host is production behaviour; a test should not leak it. */
function stopDetachedHost() {
  try {
    const meta = JSON.parse(readFileSync(join(HOST_DIR, 'meta.json'), 'utf8'))
    if (typeof meta.pid === 'number') process.kill(meta.pid, 'SIGTERM')
  } catch {
    // No host, or it already stopped.
  }
}

async function launch(label, environment, port) {
  const logPath = join(ARTIFACT_DIR, `app-${label}.log`)
  const logStream = createWriteStream(logPath)
  RUN.artifacts.push(logPath)
  appProcess = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      ICODE_GATE_USER_DATA: USER_DATA,
      ICODE_BACKGROUND_LAUNCH: '0',
      ...environment
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  appProcess.stdout.pipe(logStream)
  appProcess.stderr.pipe(logStream)
  appProcess.on('exit', (code, signal) => {
    log(`app ${label} exited code=${code} signal=${signal}`)
  })
  cdp = await connect(port)
  cdp.port = port
  await waitForSelector('[data-testid="app-rail"]', 30000)
  await waitFor(
    `Boolean(document.querySelector('[data-testid="projects-wall"]')) || Boolean(document.querySelector('[data-testid="empty-workspace"]'))`,
    'workspace wall',
    30000
  )
  await waitFor(
    `!document.body.innerText.includes('Loading repositories')`,
    'workspace boot',
    30000
  )
}

async function quitApp() {
  if (!cdp) return
  try {
    await cdp.evaluate('window.close()')
  } catch {
    // The page may disappear before the response is delivered.
  }
  const exited = await Promise.race([
    new Promise((resolvePromise) => appProcess.once('exit', () => resolvePromise(true))),
    sleep(6000).then(() => false)
  ])
  if (!exited && appProcess) {
    appProcess.kill('SIGTERM')
    await sleep(1000)
  }
  cdp = null
  appProcess = null
}

async function openProjectsWall() {
  if (
    await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="projects-wall"]')) || Boolean(document.querySelector('[data-testid="empty-add-repo"]'))`
    )
  ) {
    return
  }
  await click('[data-testid="rail-projects"]')
  await waitFor(
    `Boolean(document.querySelector('[data-testid="projects-wall"]')) || Boolean(document.querySelector('[data-testid="empty-add-repo"]'))`,
    'projects surface',
    20000
  )
}

async function openProjectSessions(repoId) {
  if (
    await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="project-sessions-list"]'))`
    )
  ) {
    return
  }
  await openProjectsWall()
  await waitForSelector(`[data-testid="open-project-${repoId}"]`, 20000)
  await click(`[data-testid="open-project-${repoId}"]`)
  await waitForSelector('[data-testid="project-header"]', 20000)
  await click('[data-testid="project-mode-sessions"]')
  await waitForSelector('[data-testid="project-sessions-list"]', 20000)
}

async function registerRepository(repoPath) {
  await openProjectsWall()
  await waitForSelector('[data-testid="empty-add-repo"]', 20000)
  await click('[data-testid="empty-add-repo"]')
  await waitForSelector('[data-testid="add-repo-input"]', 10000)
  await setInput('[data-testid="add-repo-input"]', repoPath)
  await click('[data-testid="add-repo-submit"]')
  await waitForSelector('[data-testid^="project-row-"]', 30000)
  const repoId = await cdp.evaluate(
    `document.querySelector('[data-testid^="project-row-"]')?.getAttribute('data-testid')?.replace('project-row-', '') ?? null`
  )
  assert(repoId, 'Registered repository row is missing')
  return repoId
}

async function createShellSession(repoId, title) {
  await openProjectSessions(repoId)
  await click('[data-testid="new-session-open"]')
  await waitForSelector('[data-testid="harness-list"]', 20000)
  await click('[data-testid="harness-option-shell"]')
  await setInput('[data-testid="session-title-input"]', title)
  await click('[data-testid="create-session-submit"]')
  await waitFor(
    `document.querySelector('[data-testid="session-state"]')?.dataset.state === 'live'`,
    'session live',
    30000
  )
  const list = await sessions()
  const found = list.find((entry) => entry.text.includes(title)) ?? list[0]
  assert(found, 'Created session row is missing')
  return found.id
}

async function removeRepositoryFromWall(repoId) {
  await openProjectsWall()
  await click(`[data-testid="project-menu-${repoId}"]`)
  await waitForSelector(`[data-testid="repository-remove-${repoId}"]`, 20000)
  await click(`[data-testid="repository-remove-${repoId}"]`)
}

function makeRepo(path) {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', path], { stdio: 'pipe' })
  writeFileSync(join(path, 'README.md'), '# removal smoke\n')
  execFileSync('git', ['-C', path, 'add', 'README.md'], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', path, '-c', 'user.email=icode@test', '-c', 'user.name=iCode', 'commit', '-qm', 'init'],
    { stdio: 'pipe' }
  )
}

async function main() {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(BROKEN_DIR, 'not a directory\n')
  makeRepo(REPO1)
  makeRepo(REPO2)

  let port = nextPort++
  await launch('initial', { ICODE_HOST_DIR: HOST_DIR, ICODE_HOST_SOCKET: SOCKET }, port)

  const repo1 = await step('register the first project', () => registerRepository(REPO1))
  const session1 = await step('create a live session', () =>
    createShellSession(repo1, 'Removal live shell')
  )
  const worktree1 = join(USER_DATA, 'worktrees', repo1, session1)
  assert(existsSync(worktree1), `Session worktree is missing: ${worktree1}`)

  await step('remove while the session is live and discard its dirty snapshot', async () => {
    writeFileSync(join(worktree1, 'SMOKE_DIRTY.txt'), 'uncommitted\n')
    await removeRepositoryFromWall(repo1)
    await waitFor(
      `!document.querySelector('[data-testid="project-row-${repo1}"]')`,
      'first project removed from the wall',
      20000
    )
    assert(
      await cdp.evaluate(
        `!document.querySelector('[data-testid="confirm-remove-repo"]')`
      ),
      'Removal opened a confirmation dialog'
    )
    await waitForSelector('[data-testid="cleanup-indicator"]', 20000)
    await click('[data-testid="cleanup-indicator"]')
    await waitForSelector('[data-testid="cleanup-popover"]', 10000)
    await waitForSelector('[data-testid^="cleanup-discard-"]', 30000)
    assert(
      gitRefs(REPO1, 'refs/icode/removed').includes('refs/icode/removed/'),
      'Dirty work was not saved to a recovery ref'
    )
    await waitForPathGone(worktree1, 30000)
    await screenshot('01-live-session-removed')
    await click('[data-testid^="cleanup-discard-"]')
    await waitFor(
      `!document.querySelector('[data-testid="cleanup-indicator"]')`,
      'cleanup indicator to clear after discarding snapshots',
      20000
    )
    assert(gitRefs(REPO1, 'refs/icode/removed').trim() === '', 'Snapshot refs survived discard')
    return { session1, worktree1 }
  })

  const repo2 = await step('register the second project', () => registerRepository(REPO2))
  const session2 = await step('create a session for the unreachable-Host case', () =>
    createShellSession(repo2, 'Removal waits for host')
  )
  const worktree2 = join(USER_DATA, 'worktrees', repo2, session2)
  assert(existsSync(worktree2), `Second session worktree is missing: ${worktree2}`)

  await quitApp()

  port = nextPort++
  await launch(
    'unreachable',
    {
      ICODE_HOST_DIR: BROKEN_DIR,
      ICODE_HOST_SOCKET: join(BROKEN_DIR, 'terminal-host.sock')
    },
    port
  )
  await waitFor(
    `document.querySelector('[data-testid="host-status"]')?.dataset.hostStatus === 'unreachable'`,
    'unreachable Host status',
    30000
  )

  await step('remove while the Host is unreachable and show waiting', async () => {
    await openProjectsWall()
    await waitForSelector(`[data-testid="project-row-${repo2}"]`, 20000)
    await removeRepositoryFromWall(repo2)
    await waitFor(
      `!document.querySelector('[data-testid="project-row-${repo2}"]')`,
      'second project removed from the wall',
      20000
    )
    await waitForSelector('[data-testid="cleanup-indicator"]', 20000)
    await click('[data-testid="cleanup-indicator"]')
    await waitForSelector('[data-testid="cleanup-popover"]', 10000)
    await waitFor(
      `document.querySelector('[data-testid="cleanup-popover"]')?.innerText.toLowerCase().includes('waiting for host')`,
      'cleanup waiting for the Host',
      30000
    )
    await screenshot('02-host-unreachable-waiting')
    return { waiting: true }
  })

  await quitApp()

  port = nextPort++
  await launch('resumed', { ICODE_HOST_DIR: HOST_DIR, ICODE_HOST_SOCKET: SOCKET }, port)
  // The only remaining session row is tombstoned, so the UI has no session
  // authority to derive `reachable` from; `unknown` is the truthful state here.
  await waitFor(
    `document.querySelector('[data-testid="host-status"]')?.dataset.hostStatus !== 'unreachable'`,
    'Host no longer unreachable after relaunch',
    30000
  )
  await waitForSelector('[data-testid="empty-workspace"]', 30000)

  await step('retry after the Host returns and finish cleanup', async () => {
    const indicator = await waitForSelector('[data-testid="cleanup-indicator"]', 15000)
      .then(() => true)
      .catch(() => false)
    if (indicator) {
      await click('[data-testid="cleanup-indicator"]')
      await waitForSelector('[data-testid="cleanup-popover"]', 10000)
      const retry = await waitForSelector('[data-testid^="cleanup-retry-"]', 15000)
        .then(() => true)
        .catch(() => false)
      if (retry) await click('[data-testid^="cleanup-retry-"]')
    }
    await waitForPathGone(worktree2, 30000)
    await waitFor(
      `!document.querySelector('[data-testid="cleanup-indicator"]')`,
      'cleanup indicator after Host recovery',
      30000
    )
    assert(
      gitRefs(REPO2, 'refs/icode/removed').trim() === '',
      'A clean session unexpectedly created a recovery snapshot'
    )
    assert(
      (await bodyText()).includes('Add a project'),
      'Empty workspace copy is missing after Host recovery'
    )
    await screenshot('03-host-recovered-cleanup-complete')
    return { recovered: true }
  })

  await quitApp()

  RUN.result = { status: 'passed' }
}

main()
  .then(() => {
    RUN.finishedAt = new Date().toISOString()
    stopDetachedHost()
    mkdirSync(ARTIFACT_DIR, { recursive: true })
    writeFileSync(
      join(ARTIFACT_DIR, 'removal-smoke.json'),
      `${JSON.stringify(RUN, null, 2)}\n`
    )
    log(`evidence: ${join(ARTIFACT_DIR, 'removal-smoke.json')}`)
    log(`run directory: ${RUN_DIR}`)
    log('status: passed')
  })
  .catch(async (error) => {
    RUN.finishedAt = new Date().toISOString()
    RUN.result = {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    }
    try {
      await quitApp()
    } catch {
      // Best-effort teardown.
    }
    stopDetachedHost()
    mkdirSync(ARTIFACT_DIR, { recursive: true })
    writeFileSync(
      join(ARTIFACT_DIR, 'removal-smoke.json'),
      `${JSON.stringify(RUN, null, 2)}\n`
    )
    log(`FAILED: ${RUN.result.error}`)
    log(`evidence: ${join(ARTIFACT_DIR, 'removal-smoke.json')}`)
    log(`run directory: ${RUN_DIR}`)
    process.exitCode = 1
  })
