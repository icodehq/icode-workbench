'use strict'
/**
 * Work 13 acceptance: read-only diff review through the real UI.
 *
 * Runs the packaged Linux app with an isolated XDG profile and checks the
 * changed-file list, per-file content and line mapping, refresh, truncation,
 * legacy/missing-worktree explanations, symlink and path safety, read-only
 * proof, and that switching views never respawns a PTY.
 */
const { execFileSync, spawn } = require('node:child_process')
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const PACKAGED_EXE = process.env.ADE_SMOKE_EXECUTABLE ?? join(APP_DIR, 'dist', 'linux-unpacked', 'ade')
const ARTIFACT_DIR = process.env.ADE_SMOKE_ARTIFACTS ?? join(APP_DIR, 'artifacts', 'work13')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'ade-work13-review-'))
const REPO_DIR = join(RUN_DIR, 'repo')
const XDG_CONFIG = join(RUN_DIR, 'xdg-config')
const XDG_RUNTIME = join(RUN_DIR, 'xdg-runtime')
const USER_DATA = join(XDG_CONFIG, 'ade')
const HOST_DIR = join(USER_DATA, 'run')

const RUN = {
  work: 13,
  startedAt: new Date().toISOString(),
  runDir: RUN_DIR,
  steps: [],
  criteria: {},
  failures: [],
  artifacts: []
}

let cdp = null
let appProcess = null
let hostPid = null

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (message) => process.stdout.write(`[review] ${message}\n`)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function git(...args) {
  return execFileSync('git', ['-C', REPO_DIR, ...args], { encoding: 'utf8' }).trim()
}

async function allocatePort() {
  const net = require('node:net')
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function step(name, criterion, work) {
  const startedAt = Date.now()
  log(name)
  try {
    const details = await work()
    RUN.steps.push({
      name,
      criterion,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      ...(details === undefined ? {} : { details })
    })
    RUN.criteria[criterion] = 'PASS'
    persist()
    return details
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    RUN.steps.push({
      name,
      criterion,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: message
    })
    RUN.criteria[criterion] = 'FAIL'
    RUN.failures.push(`${name}: ${message}`)
    persist()
    throw error
  }
}

function persist() {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFileSync(
    join(ARTIFACT_DIR, 'review.json'),
    `${JSON.stringify(RUN, null, 2)}\n`
  )
}

async function screenshot(name) {
  if (!cdp) return
  const path = join(ARTIFACT_DIR, `${name}.png`)
  try {
    await cdp.screenshot(path)
    RUN.artifacts.push(path)
  } catch (error) {
    RUN.artifacts.push(`${path} (failed: ${String(error)})`)
  }
}

async function waitFor(expression, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression)
      if (last) return last
    } catch (error) {
      last = String(error)
    }
    await sleep(150)
  }
  throw new Error(`Timed out waiting for ${description} (last: ${JSON.stringify(last)})`)
}

async function click(selector) {
  const ok = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`)
  assert(ok, `Could not click ${selector}`)
}

async function setInput(selector, value) {
  const ok = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === ${JSON.stringify(value)};
  })()`)
  assert(ok, `Could not set ${selector}`)
}

async function waitForNotice(needle, timeoutMs = 20000) {
  await waitFor(
    `(() => { const n = document.querySelector('[data-testid="notice"]'); return Boolean(n && n.innerText.includes(${JSON.stringify(needle)})); })()`,
    `notice "${needle}"`,
    timeoutMs
  )
}

async function sessions() {
  return cdp.evaluate(`Array.from(document.querySelectorAll('[data-session-id]')).map((el) => ({
    id: el.dataset.sessionId,
    state: el.dataset.sessionState,
    incarnation: el.dataset.sessionIncarnation,
    text: el.innerText
  }))`)
}

async function launch(label) {
  mkdirSync(XDG_CONFIG, { recursive: true })
  mkdirSync(XDG_RUNTIME, { recursive: true, mode: 0o700 })
  const logPath = join(ARTIFACT_DIR, `app-${label}.log`)
  const stream = createWriteStream(logPath)
  RUN.artifacts.push(logPath)
  const port = await allocatePort()
  appProcess = spawn(PACKAGED_EXE, [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: XDG_CONFIG,
      XDG_RUNTIME_DIR: XDG_RUNTIME,
      DISPLAY: process.env.DISPLAY ?? ':0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  appProcess.stdout.pipe(stream)
  appProcess.stderr.pipe(stream)
  appProcess.on('exit', (code, signal) => log(`app ${label} exited code=${code} signal=${signal}`))
  cdp = await connect(port)
  cdp.port = port
  await waitFor(
    `Boolean(document.querySelector('[data-testid="repo-select"]')) && !document.body.innerText.includes('Loading repositories')`,
    'workspace boot',
    30000
  )
}

async function quitApp() {
  if (!cdp) return
  try {
    await Promise.race([cdp.evaluate('window.close()'), sleep(2500)])
  } catch {
    // Page may close first.
  }
  const exited = await Promise.race([
    new Promise((done) => appProcess.once('exit', () => done(true))),
    sleep(6000).then(() => false)
  ])
  if (!exited && appProcess) {
    appProcess.kill('SIGTERM')
    await sleep(1500)
  }
  try {
    cdp.close()
  } catch {
    // Already closed.
  }
  cdp = null
  appProcess = null
  await sleep(300)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function hostMeta() {
  const path = join(HOST_DIR, 'meta.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function hostEvents() {
  const path = join(HOST_DIR, 'host.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function indexPath(worktreePath) {
  return execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'index'], {
    encoding: 'utf8'
  }).trim()
}

async function createShellSession(title) {
  const opening = await cdp.evaluate(
    `Boolean(document.querySelector('[data-testid="empty-new-session"]'))`
  )
  await click(opening ? '[data-testid="empty-new-session"]' : '[data-testid="new-session-open"]')
  await waitFor(
    `Boolean(document.querySelector('[data-testid="harness-option-shell"]'))`,
    'new session dialog'
  )
  await click('[data-testid="harness-option-shell"]')
  await setInput('[data-testid="session-title-input"]', title)
  await click('[data-testid="create-session-submit"]')
  await waitFor(
    `document.querySelector('[data-testid="session-title"]')?.innerText === ${JSON.stringify(title)}`,
    `session ${title}`,
    30000
  )
  const list = await sessions()
  const session = list.find((entry) => entry.text.split('\n')[0] === title)
  assert(session, `Session ${title} is missing`)
  return session
}

async function openChanges() {
  await click('[data-testid="view-changes"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="changes-panel"]'))`, 'changes panel')
}

async function waitReviewReady(timeoutMs = 30000) {
  await waitFor(
    `(() => {
      const el = document.querySelector('[data-testid="changes-panel"]');
      if (!el) return false;
      const phase = el.getAttribute('data-phase');
      return phase === 'ready' || phase === 'empty' || phase === 'unavailable' || phase === 'error';
    })()`,
    'review to settle',
    timeoutMs
  )
  return cdp.evaluate(
    `document.querySelector('[data-testid="changes-panel"]').getAttribute('data-phase')`
  )
}

async function fileRows() {
  return cdp.evaluate(`Array.from(document.querySelectorAll('[data-testid^="review-file-"]')).map((el) => ({
    path: el.getAttribute('data-testid').replace('review-file-', ''),
    status: el.getAttribute('data-status'),
    area: el.getAttribute('data-area'),
    text: el.innerText
  }))`)
}

async function selectFile(path) {
  await click(`[data-testid="review-file-${path}"]`)
  await waitFor(
    `Boolean(document.querySelector('[data-testid="review-diff-${path}"]'))`,
    `diff for ${path}`
  )
}

async function diffText(path) {
  return cdp.evaluate(`(() => {
    const root = document.querySelector('[data-testid="review-diff-${path}"]');
    return root ? root.innerText : '';
  })()`)
}

async function main() {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: REPO_DIR })
  writeFileSync(join(REPO_DIR, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(REPO_DIR, 'gone.txt'), 'delete me\n')
  writeFileSync(join(REPO_DIR, 'crlf.txt'), 'alpha\r\nbeta\r\n')
  git('add', '.')
  execFileSync(
    'git',
    ['-c', 'user.email=ade@test', '-c', 'user.name=ADE', 'commit', '-qm', 'init'],
    { cwd: REPO_DIR }
  )

  RUN.build = {
    executable: PACKAGED_EXE,
    userData: USER_DATA,
    gateOverrides: Object.keys(process.env).filter((key) => key.startsWith('ADE_GATE_'))
  }
  persist()

  await step('register a repository and create a session', 'AC1', async () => {
    await launch('initial')
    await click('[data-testid="empty-add-repo"]')
    await setInput('[data-testid="add-repo-input"]', REPO_DIR)
    await click('[data-testid="add-repo-submit"]')
    await waitForNotice('Registered')
    const session = await createShellSession('Review session')
    await waitFor(`Boolean(document.querySelector('[data-testid="view-changes"]'))`, 'view toggle')
    return { session }
  })

  const state = {}
  await step('produce committed, unstaged, untracked, deleted and binary changes', 'AC1', async () => {
    const list = await sessions()
    state.session = list.find((entry) => entry.text.startsWith('Review session'))
    assert(state.session, 'session missing')
    const worktreePath = await cdp.evaluate(
      `document.querySelector('[data-testid="session-worktree"]')?.getAttribute('title') ?? ''`
    )
    assert(worktreePath.includes('/worktrees/'), `worktree path not shown: ${worktreePath}`)
    state.worktreePath = worktreePath.split(' · ').pop().trim()
    assert(existsSync(state.worktreePath), 'worktree directory is missing')

    // Committed agent-style edit.
    writeFileSync(join(state.worktreePath, 'a.txt'), 'one\nTWO\nthree\n')
    gitIn(state.worktreePath, 'add', 'a.txt')
    commitIn(state.worktreePath, 'agent edit')
    // Unstaged edit.
    writeFileSync(join(state.worktreePath, 'crlf.txt'), 'alpha\r\nBETA\r\n')
    // Untracked file.
    writeFileSync(join(state.worktreePath, 'fresh.txt'), 'hello\nworld\n')
    // Deletion.
    unlinkSync(join(state.worktreePath, 'gone.txt'))
    // Binary file.
    writeFileSync(
      join(state.worktreePath, 'blob.bin'),
      Buffer.from(Array.from({ length: 4096 }, (_v, i) => i % 256))
    )
    return { worktreePath: state.worktreePath }
  })

  await step('list every change with correct identity, status and counts', 'AC1', async () => {
    await openChanges()
    const phase = await waitReviewReady()
    assert(phase === 'ready', `unexpected review phase: ${phase}`)
    const rows = await fileRows()
    const byPath = new Map(rows.map((row) => [row.path, row]))
    for (const path of ['a.txt', 'crlf.txt', 'fresh.txt', 'gone.txt', 'blob.bin']) {
      assert(byPath.has(path), `missing review row for ${path}`)
    }
    assert(byPath.get('a.txt').status === 'modified', 'a.txt should be modified')
    assert(byPath.get('fresh.txt').status === 'added', 'fresh.txt should be added')
    assert(byPath.get('fresh.txt').area === 'untracked', 'fresh.txt should be untracked')
    assert(byPath.get('gone.txt').status === 'deleted', 'gone.txt should be deleted')
    assert(byPath.get('blob.bin').text.includes('binary'), 'binary row should be labelled')

    const numstat = execFileSync(
      'git',
      ['-C', state.worktreePath, 'diff', '--numstat', 'HEAD~1', '--'],
      { encoding: 'utf8' }
    )
    const aLine = numstat.split('\n').find((line) => line.endsWith('\ta.txt'))
    assert(aLine, 'a.txt missing from numstat')
    assert(byPath.get('a.txt').text.includes(aLine.split('\t')[0]), 'addition count mismatch')
    assert(byPath.get('a.txt').text.includes(aLine.split('\t')[1]), 'deletion count mismatch')
    await screenshot('01-changed-files')
    return { rows }
  })

  await step('render a unified diff that matches Git content and line numbers', 'AC2', async () => {
    await selectFile('a.txt')
    const rendered = await diffText('a.txt')
    const expected = execFileSync(
      'git',
      ['-C', state.worktreePath, 'diff', 'HEAD~1', '--', 'a.txt'],
      { encoding: 'utf8' }
    )
    const expectedAdded = expected
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
    const expectedRemoved = expected
      .split('\n')
      .filter((line) => line.startsWith('-') && !line.startsWith('---'))
      .map((line) => line.slice(1))
    for (const line of expectedAdded) assert(rendered.includes(line), `missing added line: ${line}`)
    for (const line of expectedRemoved) {
      assert(rendered.includes(line), `missing removed line: ${line}`)
    }
    assert(rendered.includes('@@ -1,3 +1,3 @@'), 'hunk header not rendered')
    await screenshot('02-modified-diff')

    // CRLF: content is shown, the CR is not leaked into the visible text.
    await selectFile('crlf.txt')
    const crlf = await diffText('crlf.txt')
    assert(crlf.includes('BETA'), 'CRLF addition missing')
    assert(!crlf.includes('\r'), 'raw CR leaked into the rendered diff')
    assert(crlf.includes('CRLF'), 'CRLF marker missing')

    // Untracked content is diffed, not reported as empty.
    await selectFile('fresh.txt')
    const fresh = await diffText('fresh.txt')
    assert(fresh.includes('hello') && fresh.includes('world'), 'untracked content missing')

    // Deletion shows removed lines.
    await selectFile('gone.txt')
    const gone = await diffText('gone.txt')
    assert(gone.includes('delete me'), 'deleted content missing')

    // Binary shows the binary state, not an empty pane.
    await selectFile('blob.bin')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="review-diff-binary"]'))`,
      'binary state'
    )
    await screenshot('03-binary')
    return { expectedAdded, expectedRemoved }
  })

  await step('refresh shows new work without a stale view', 'AC3', async () => {
    writeFileSync(join(state.worktreePath, 'later.txt'), 'later\n')
    await click('[data-testid="review-refresh"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="review-file-later.txt"]'))`,
      'new file after refresh'
    )
    const rows = await fileRows()
    assert(rows.some((row) => row.path === 'later.txt'), 'refreshed list is missing later.txt')
    await screenshot('04-refreshed')
    return { files: rows.length }
  })

  await step('report truncation explicitly for an oversized diff', 'AC4', async () => {
    writeFileSync(join(state.worktreePath, 'huge.txt'), 'x\n'.repeat(1_200_000))
    await click('[data-testid="review-refresh"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="review-file-huge.txt"]'))`,
      'huge file in list'
    )
    await selectFile('huge.txt')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="review-diff-truncated"]'))`,
      'truncation banner',
      30000
    )
    const body = await cdp.evaluate(
      `document.querySelector('[data-testid="review-diff-huge.txt"]').innerText`
    )
    assert(body.toLowerCase().includes('incomplete'), 'truncation is not stated in the diff')
    await screenshot('05-truncated')
    return { banner: true }
  })

  await step('switch views without respawning the PTY', 'AC5', async () => {
    const before = (await sessions()).find((entry) => entry.id === state.session.id)
    const spawnsBefore = hostEvents().filter(
      (event) => event.event === 'pty-spawn' && event.sessionId === state.session.id
    ).length
    await click('[data-testid="view-terminal"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="terminal-pane-${state.session.id}"]'))`,
      'terminal pane still mounted'
    )
    await click('[data-testid="view-changes"]')
    await waitFor(`Boolean(document.querySelector('[data-testid="changes-panel"]'))`, 'changes panel')
    const spawnsAfter = hostEvents().filter(
      (event) => event.event === 'pty-spawn' && event.sessionId === state.session.id
    ).length
    const after = (await sessions()).find((entry) => entry.id === state.session.id)
    assert(spawnsAfter === spawnsBefore, `PTY respawned (${spawnsBefore} → ${spawnsAfter})`)
    assert(after.incarnation === before.incarnation, 'view switch changed the incarnation')
    await screenshot('06-view-toggle')
    return { spawns: spawnsAfter, incarnation: after.incarnation }
  })

  await step('prove review is read-only', 'AC6', async () => {
    const statusBefore = execFileSync(
      'git',
      ['-C', state.worktreePath, 'status', '--porcelain'],
      { encoding: 'utf8' }
    )
    const indexFile = indexPath(state.worktreePath)
    const indexBefore = execFileSync('stat', ['-c', '%Y', indexFile], {
      encoding: 'utf8'
    }).trim()

    await click('[data-testid="review-refresh"]')
    await waitReviewReady()
    for (const row of await fileRows()) {
      await selectFile(row.path).catch(() => undefined)
    }

    const indexAfter = execFileSync('stat', ['-c', '%Y', indexFile], {
      encoding: 'utf8'
    }).trim()
    const statusAfter = execFileSync(
      'git',
      ['-C', state.worktreePath, 'status', '--porcelain'],
      { encoding: 'utf8' }
    )
    assert(statusAfter === statusBefore, 'review changed the working tree status')
    assert(indexAfter === indexBefore, 'review touched the Git index')
    assert(!existsSync(`${indexFile}.lock`), 'index.lock was left behind')
    return { indexMtime: indexBefore }
  })

  await step('explain a missing worktree without falling back', 'AC8', async () => {
    await quitApp()
    const moved = `${state.worktreePath}-moved`
    execFileSync('mv', [state.worktreePath, moved])
    await launch('missing')
    await waitFor(
      `Array.from(document.querySelectorAll('[data-session-id]')).some((el) => el.innerText.includes('Review session'))`,
      'session restored',
      30000
    )
    const session = (await sessions()).find((entry) => entry.text.startsWith('Review session'))
    await click(`[data-testid="session-item-${session.id}"]`)
    await sleep(300)
    await click('[data-testid="view-changes"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="review-unavailable-reason"]'))`,
      'unavailable explanation'
    )
    const text = await cdp.evaluate(
      `document.querySelector('[data-testid="changes-panel"]').innerText`
    )
    assert(text.toLowerCase().includes('worktree is missing'), 'missing-worktree explanation absent')
    assert(!text.includes('a.txt'), 'review listed files for a missing worktree')
    await screenshot('07-missing-worktree')
    execFileSync('mv', [moved, state.worktreePath])
    return { explanation: text.split('\n')[0] }
  })

  await step('refuse an escaping path at the IPC boundary', 'AC9', async () => {
    const result = await cdp.evaluate(`window.ade.review.diff({
      sessionId: ${JSON.stringify(state.session.id)},
      path: '../etc/passwd'
    })`)
    assert(result.ok === false, 'escaping path was accepted')
    assert(result.error.code === 'INVALID_ARGUMENT', `unexpected error: ${result.error.code}`)
    return { code: result.error.code }
  })

  await step('never expose symlink target contents', 'AC10', async () => {
    const outside = join(RUN_DIR, 'outside-secret.txt')
    writeFileSync(outside, 'OUTSIDE-SECRET\n')
    const linkPath = join(state.worktreePath, 'link-out.txt')
    try {
      execFileSync('ln', ['-s', outside, linkPath])
    } catch {
      // Already present from an earlier attempt.
    }
    await click('[data-testid="review-refresh"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="review-file-link-out.txt"]'))`,
      'symlink row'
    )
    await selectFile('link-out.txt')
    const text = await diffText('link-out.txt')
    assert(!text.includes('OUTSIDE-SECRET'), 'symlink target content leaked into the diff')
    assert(text.includes(outside), 'symlink target path was not shown')
    await screenshot('08-symlink')
    return { target: outside }
  })

  await step('clean up the test session, host and run directory', 'AC11', async () => {
    const meta = hostMeta()
    hostPid = meta?.pid ?? null
    await quitApp()
    if (hostPid && pidAlive(hostPid)) {
      process.kill(hostPid, 'SIGTERM')
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && pidAlive(hostPid)) await sleep(200)
    }
    assert(!hostPid || !pidAlive(hostPid), 'test host is still running')

    const lingering = []
    for (const entry of execFileSync('sh', ['-c', 'ls /proc'], { encoding: 'utf8' })
      .split('\n')
      .filter((value) => /^\d+$/.test(value))) {
      try {
        const cwd = execFileSync('readlink', [`/proc/${entry}/cwd`], { encoding: 'utf8' }).trim()
        if (cwd.startsWith(RUN_DIR)) lingering.push(Number(entry))
      } catch {
        // Process vanished.
      }
    }
    assert(lingering.length === 0, `test processes still running: ${lingering.join(',')}`)
    rmSync(RUN_DIR, { recursive: true, force: true })
    return { hostPid, removed: true }
  })

  RUN.finishedAt = new Date().toISOString()
  RUN.status = 'passed'
}

function gitIn(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
}

function commitIn(cwd, message) {
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.email=ade@test', '-c', 'user.name=ADE', 'commit', '-qm', message],
    { stdio: 'pipe' }
  )
}

async function run() {
  try {
    await main()
  } catch (error) {
    RUN.status = 'failed'
    RUN.finishedAt = new Date().toISOString()
    RUN.failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    await screenshot('failure')
    log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
    try {
      await quitApp()
    } catch {
      // teardown best effort
    }
    try {
      if (hostPid && pidAlive(hostPid)) process.kill(hostPid, 'SIGTERM')
    } catch {
      // already gone
    }
    process.exitCode = 1
  } finally {
    persist()
    log(`evidence: ${join(ARTIFACT_DIR, 'review.json')}`)
    log(`status: ${RUN.status}`)
  }
}

void run()
