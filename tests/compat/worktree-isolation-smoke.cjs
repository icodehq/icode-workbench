'use strict'
/**
 * Work 12 acceptance: per-session worktree isolation through the real UI.
 *
 * Runs the current build through the local Electron by default (set
 * ICODE_SMOKE_EXECUTABLE to test a packaged app) with an isolated XDG profile
 * (no ICODE_GATE_* overrides). It exercises two concurrent sessions, isolation,
 * quit/relaunch, restart, removal protection, discard, branch retention and
 * branch deletion.
 */
const { execFileSync, spawn } = require('node:child_process')
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  createWriteStream
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const ELECTRON = require('electron')
const EXPLICIT_EXECUTABLE = process.env.ICODE_SMOKE_EXECUTABLE ?? null
const APP_EXECUTABLE = EXPLICIT_EXECUTABLE ?? ELECTRON
const ARTIFACT_DIR = process.env.ICODE_SMOKE_ARTIFACTS ?? join(APP_DIR, 'artifacts', 'work12')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'icode-work12-accept-'))
const REPO_DIR = join(RUN_DIR, 'repo')
const XDG_CONFIG = join(RUN_DIR, 'xdg-config')
const XDG_RUNTIME = join(RUN_DIR, 'xdg-runtime')
const USER_DATA = join(XDG_CONFIG, 'iCode')
const HOST_DIR = join(USER_DATA, 'run')

const RUN = {
  work: 12,
  startedAt: new Date().toISOString(),
  runDir: RUN_DIR,
  steps: [],
  failures: [],
  artifacts: [],
  criteria: {}
}
let cdp = null
let appProcess = null
let nextPort = 0

/** Ask the OS for a free port so a stale DevTools listener cannot collide. */
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
let hostPid = null

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (message) => process.stdout.write(`[worktree] ${message}\n`)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function git(...args) {
  return execFileSync('git', ['-C', REPO_DIR, ...args], { encoding: 'utf8' }).trim()
}

function worktreeEntries() {
  const output = execFileSync('git', ['-C', REPO_DIR, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8'
  })
  const entries = []
  let current = null
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), branch: null }
      continue
    }
    if (current && line.startsWith('branch ')) {
      current.branch = line.slice(7).replace('refs/heads/', '')
    }
    if (current && line === '') {
      entries.push(current)
      current = null
    }
  }
  if (current) entries.push(current)
  return entries
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

function persist() {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFileSync(join(ARTIFACT_DIR, 'worktree-isolation.json'), `${JSON.stringify(RUN, null, 2)}\n`)
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

async function openSessionMenu() {
  if (
    await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="session-menu-popover"]'))`
    )
  ) {
    return
  }
  await click('[data-testid="session-menu"]')
  await waitFor(
    `Boolean(document.querySelector('[data-testid="session-menu-popover"]'))`,
    'the Session menu'
  )
}

async function sessionAction(testId) {
  await openSessionMenu()
  await click(`[data-testid="${testId}"]`)
}

async function requestRemoveSession() {
  await sessionAction('remove-session')
  await waitFor(
    `Boolean(document.querySelector('[data-testid="remove-session-dialog"]'))`,
    'the Remove session dialog'
  )
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

async function notice() {
  return cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="notice"]');
    return el ? { tone: el.dataset.tone, text: el.innerText } : null;
  })()`)
}

async function waitForNotice(needle, timeoutMs = 20000) {
  await waitFor(
    `(() => { const n = document.querySelector('[data-testid="notice"]'); return Boolean(n && n.innerText.includes(${JSON.stringify(needle)})); })()`,
    `notice "${needle}"`,
    timeoutMs
  )
  return notice()
}

async function sessions() {
  return cdp.evaluate(`Array.from(document.querySelectorAll('[data-session-id]')).map((el) => ({
    id: el.dataset.sessionId,
    state: el.dataset.sessionState,
    incarnation: el.dataset.sessionIncarnation,
    text: el.innerText
  }))`)
}

async function activeSession() {
  return cdp.evaluate(`(() => {
    const w = document.querySelector('[data-testid="session-worktree"]');
    return {
      id: document.querySelector('[data-session-id][aria-current], [data-session-id]')?.dataset?.sessionId ?? null,
      title: document.querySelector('[data-testid="session-title"]')?.innerText ?? null,
      state: document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') ?? null,
      worktree: w ? {
        branch: w.getAttribute('data-worktree-branch'),
        status: w.getAttribute('data-worktree-status'),
        text: w.innerText
      } : null
    };
  })()`)
}

async function rows(sessionId) {
  return cdp.evaluate(`(() => {
    const pane = document.querySelector('[data-testid="terminal-pane-${sessionId}"]');
    return pane ? Array.from(pane.querySelectorAll('.xterm-rows > div')).map((r) => r.textContent || '') : [];
  })()`)
}

async function focusTerminal(sessionId) {
  const ok = await cdp.evaluate(`(() => {
    const pane = document.querySelector('[data-testid="terminal-pane-${sessionId}"]');
    const ta = pane && pane.querySelector('.xterm-helper-textarea');
    if (!ta) return false;
    ta.focus();
    return document.activeElement === ta;
  })()`)
  assert(ok, `Terminal ${sessionId} is not focusable`)
}

async function typeLine(sessionId, text) {
  await focusTerminal(sessionId)
  await cdp.send('Input.insertText', { text })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    text: '\r'
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
  await sleep(700)
}

async function waitForLine(sessionId, predicate, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await rows(sessionId)
    if (last.some(predicate)) return last
    await sleep(150)
  }
  throw new Error(`Timed out waiting for ${description} (last: ${JSON.stringify(last.slice(0, 12))})`)
}

async function launch(label) {
  mkdirSync(XDG_CONFIG, { recursive: true })
  mkdirSync(XDG_RUNTIME, { recursive: true, mode: 0o700 })
  const logPath = join(ARTIFACT_DIR, `app-${label}.log`)
  const stream = createWriteStream(logPath)
  RUN.artifacts.push(logPath)
  const port = await allocatePort()
  appProcess = spawn(
    APP_EXECUTABLE,
    EXPLICIT_EXECUTABLE ? [`--remote-debugging-port=${port}`] : ['.', `--remote-debugging-port=${port}`],
    {
    cwd: APP_DIR,
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
    `Boolean(document.querySelector('[data-testid="workspace-sidebar"]')) && (Boolean(document.querySelector('[data-testid="empty-workspace"]')) || Boolean(document.querySelector('[data-testid^="project-row-"]'))) && !document.body.innerText.includes('Loading repositories')`,
    'workspace boot',
    30000
  )
}

async function quitApp() {
  if (!cdp) return
  try {
    await Promise.race([cdp.evaluate('window.close()'), sleep(2500)])
  } catch {
    // Page may close before replying.
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

async function createShellSession(title) {
  const opening = await cdp.evaluate(
    `Boolean(document.querySelector('[data-testid="empty-new-session"]'))`
  )
  if (opening) {
    await click('[data-testid="empty-new-session"]')
  } else {
    await click('[data-testid="sidebar-new-menu"]')
    await waitFor(`Boolean(document.querySelector('[data-testid="new-session-open"]'))`, 'new session menu', 10000)
    await click('[data-testid="new-session-open"]')
  }
  await waitFor(`Boolean(document.querySelector('[data-testid="harness-option-shell"]'))`, 'new session dialog')
  await click('[data-testid="harness-option-shell"]')
  await setInput('[data-testid="session-title-input"]', title)
  await click('[data-testid="create-session-submit"]')
  await waitFor(
    `document.querySelector('[data-testid="session-title"]')?.innerText === ${JSON.stringify(title)}`,
    `session ${title} to open`,
    30000
  )
  await waitFor(`Boolean(document.querySelector('[data-testid="session-worktree"]'))`, 'worktree badge')
  const list = await sessions()
  const session = list.find((entry) => entry.text.split('\n')[0] === title)
  assert(session, `Session ${title} is missing from the sidebar`)
  return session
}

async function selectSession(sessionId) {
  await click(`[data-testid="session-item-${sessionId}"]`)
  await sleep(300)
}

async function terminalReady(sessionId) {
  await waitForLine(sessionId, (line) => /\$\s*$/.test(line), 'shell prompt')
}


async function openProjectSessions() {
  if (await cdp.evaluate(`Boolean(document.querySelector('[data-testid="sessions-surface"]'))`)) return
  const repoTestId = await cdp.evaluate(
    `document.querySelector('[data-testid^="project-row-"]')?.getAttribute('data-testid') ?? null`
  )
  assert(repoTestId, 'No project lane after relaunch')
  await click(`[data-testid="${repoTestId}"]`)
  await waitFor(`Boolean(document.querySelector('[data-testid="sessions-surface"]'))`, 'sessions surface', 20000)
}

async function main() {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: REPO_DIR })
  writeFileSync(join(REPO_DIR, 'README.md'), '# worktree acceptance\n')
  execFileSync('git', ['add', 'README.md'], { cwd: REPO_DIR })
  execFileSync(
    'git',
    ['-c', 'user.email=icode@test', '-c', 'user.name=iCode', 'commit', '-qm', 'init'],
    { cwd: REPO_DIR }
  )
  RUN.build = {
    executable: APP_EXECUTABLE,
    userData: USER_DATA,
    worktreeRoot: join(USER_DATA, 'worktrees'),
    gateOverrides: Object.keys(process.env).filter((key) => key.startsWith('ICODE_GATE_'))
  }
  persist()

  await step('register the repository and create two shell sessions', 'AC1', async () => {
    await launch('initial')
    await click('[data-testid="empty-add-repo"]')
    await setInput('[data-testid="add-repo-input"]', REPO_DIR)
    await click('[data-testid="add-repo-submit"]')
    await waitForNotice('Registered')

    const first = await createShellSession('Worktree A')
    const second = await createShellSession('Worktree B')
    await screenshot('01-two-sessions')

    const firstInfo = await cdp.evaluate(`(() => {
      const w = document.querySelector('[data-testid="session-worktree"]');
      return w ? { branch: w.getAttribute('data-worktree-branch'), status: w.getAttribute('data-worktree-status') } : null;
    })()`)
    return { first, second, currentWorktree: firstInfo }
  })

  const state = {}
  await step('assign distinct branches and worktree paths', 'AC1', async () => {
    const list = await sessions()
    const a = list.find((entry) => entry.text.startsWith('Worktree A'))
    const b = list.find((entry) => entry.text.startsWith('Worktree B'))
    assert(a && b, 'Both sessions must exist')
    state.a = a
    state.b = b

    const entries = worktreeEntries()
    const branchOf = (sessionId) => {
      const entry = entries.find((item) => item.branch && item.branch.endsWith(sessionId))
      return entry ?? null
    }
    const aEntry = branchOf(a.id)
    const bEntry = branchOf(b.id)
    assert(aEntry, 'Session A has no registered worktree')
    assert(bEntry, 'Session B has no registered worktree')
    assert(aEntry.path !== bEntry.path, 'Sessions share a worktree path')
    assert(aEntry.branch !== bEntry.branch, 'Sessions share a branch')
    assert(
      !entries.find((item) => item.path === REPO_DIR)?.branch?.startsWith('icode/'),
      'The primary checkout must stay on its own branch'
    )
    state.aEntry = aEntry
    state.bEntry = bEntry
    return { entries }
  })

  await step('isolate file writes while both PTYs stay alive', 'AC2', async () => {
    await selectSession(state.a.id)
    await terminalReady(state.a.id)
    await typeLine(state.a.id, 'echo isolated > separate.txt; pwd; echo MARKER_A')
    await waitForLine(state.a.id, (line) => line.trim() === 'MARKER_A', 'session A marker')

    await selectSession(state.b.id)
    await terminalReady(state.b.id)
    await typeLine(state.b.id, 'ls separate.txt 2>&1; echo MARKER_B')
    await waitForLine(state.b.id, (line) => line.trim() === 'MARKER_B', 'session B marker')

    assert(existsSync(join(state.aEntry.path, 'separate.txt')), 'Session A worktree lacks its file')
    assert(!existsSync(join(state.bEntry.path, 'separate.txt')), 'Session B saw session A file')
    assert(!existsSync(join(REPO_DIR, 'separate.txt')), 'The primary checkout was modified')

    const bRows = (await rows(state.b.id)).join('\n')
    assert(bRows.includes('No such file'), 'Session B terminal did not report the missing file')

    await screenshot('02-isolated-writes')
    state.aIncarnation = state.a.incarnation
    return { aPath: state.aEntry.path, bPath: state.bEntry.path }
  })

  await step('keep the same worktree across quit and relaunch', 'AC4', async () => {
    const meta = hostMeta()
    assert(meta && pidAlive(meta.pid), 'Detached host is not alive before quit')
    hostPid = meta.pid
    const before = await sessions()

    await quitApp()
    await sleep(800)
    assert(pidAlive(hostPid), 'Detached host died with the app')
    await launch('relaunch')
    await sleep(1500)
    await openProjectSessions()
    await waitFor(
      `new Set(Array.from(document.querySelectorAll('[data-session-id]')).map((el) => el.dataset.sessionId)).size === 2`,
      'sessions restored',
      30000
    )
    const after = await sessions()
    const aAfter = after.find((entry) => entry.text.startsWith('Worktree A'))
    const bAfter = after.find((entry) => entry.text.startsWith('Worktree B'))
    assert(aAfter && bAfter, 'Sessions missing after relaunch')
    const aBefore = before.find((entry) => entry.text.startsWith('Worktree A'))
    assert(aAfter.incarnation === aBefore.incarnation, 'Relaunch changed the incarnation')

    const entries = worktreeEntries()
    assert(
      entries.some((entry) => entry.path === state.aEntry.path),
      'The worktree was not preserved across relaunch'
    )

    const events = hostEvents()
    for (const session of [state.a, state.b]) {
      const spawns = events.filter(
        (event) => event.event === 'pty-spawn' && event.sessionId === session.id
      )
      assert(spawns.length === 1, `Expected one PTY spawn for ${session.id}, saw ${String(spawns.length)}`)
    }
    await selectSession(aAfter.id)
    await terminalReady(aAfter.id)
    await typeLine(aAfter.id, 'echo RELAUNCH_OK')
    await waitForLine(aAfter.id, (line) => line.trim() === 'RELAUNCH_OK', 'reattached terminal')
    await screenshot('03-relaunched')
    state.a = aAfter
    return { incarnation: aAfter.incarnation, entries: entries.map((entry) => entry.branch) }
  })

  await step('restart in the same worktree with a new incarnation', 'AC5', async () => {
    const before = state.a
    await sessionAction('restart-session')
    await waitFor(
      `(() => {
        const item = document.querySelector('[data-session-id="${before.id}"]');
        return Boolean(item) &&
          item.dataset.sessionIncarnation !== ${JSON.stringify(before.incarnation)} &&
          item.dataset.sessionState === 'live';
      })()`,
      'restart to produce a new incarnation',
      30000
    )
    const after = (await sessions()).find((entry) => entry.id === before.id)
    assert(after, 'Restarted session disappeared')
    assert(after.incarnation !== before.incarnation, 'Restart reused the incarnation')
    const entries = worktreeEntries()
    assert(entries.some((entry) => entry.path === state.aEntry.path), 'Restart moved the worktree')
    const worktree = await cdp.evaluate(
      `document.querySelector('[data-testid="session-worktree"]')?.getAttribute('data-worktree-branch')`
    )
    assert(worktree === state.aEntry.branch, 'Restart changed the branch')
    state.a = after
    return { before: before.incarnation, after: after.incarnation, branch: worktree }
  })

  await step('confirm before removing a live session', 'AC6', async () => {
    await requestRemoveSession()
    const text = await cdp.evaluate(
      `document.querySelector('[data-testid="remove-session-dialog"]').innerText`
    )
    assert(text.includes('branch is kept'), 'Removal does not say the branch is kept')
    assert(
      text.includes('uncommitted work is protected'),
      'Removal does not say uncommitted work is protected'
    )
    assert(!text.includes('terminal process'), 'Removal exposes terminal-process internals')
    assert(!text.includes('worktree'), 'Removal exposes worktree internals')
    await screenshot('04-live-removal-confirmation')
    await click('[data-testid="remove-session-cancel"]')
    await waitFor(
      `!document.querySelector('[data-testid="remove-session-dialog"]')`,
      'the Remove dialog to close'
    )
    assert(existsSync(state.aEntry.path), 'Cancelled removal deleted the worktree')
    return { text: text.trim().split('\n').filter(Boolean) }
  })

  await step('protect uncommitted work and require an exact discard confirmation', 'AC7', async () => {
    writeFileSync(join(state.aEntry.path, 'uncommitted.txt'), 'work in progress\n')
    await requestRemoveSession()
    await click('[data-testid="remove-session-confirm"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="worktree-cleanup-dialog"]'))`,
      'cleanup dialog',
      20000
    )
    const dialog = await cdp.evaluate(
      `document.querySelector('[data-testid="worktree-cleanup-dialog"]').innerText`
    )
    assert(dialog.includes('Uncommitted changes'), 'Dialog does not explain the dirty blocker')
    assert(dialog.includes('uncommitted.txt'), 'Dialog does not list the dirty file')

    const disabledBefore = await cdp.evaluate(
      `document.querySelector('[data-testid="discard-confirm"]').disabled`
    )
    assert(disabledBefore, 'Discard is enabled without typing the branch')
    await screenshot('05-dirty-blocked')

    // Wrong name must stay disabled (the input is compared to the real branch).
    await setInput('[data-testid="discard-confirm-input"]', 'not-the-branch')
    const disabledWrong = await cdp.evaluate(
      `document.querySelector('[data-testid="discard-confirm"]').disabled`
    )
    assert(disabledWrong, 'Discard accepted a wrong branch name')
    await setInput('[data-testid="discard-confirm-input"]', state.aEntry.branch)
    const disabledRight = await cdp.evaluate(
      `document.querySelector('[data-testid="discard-confirm"]').disabled`
    )
    assert(!disabledRight, 'Discard did not enable with the exact branch')
    await click('[data-testid="discard-confirm"]')
    await waitFor(
      `!Array.from(document.querySelectorAll('[data-session-id]')).some((el) => el.innerText.includes('Worktree A'))`,
      'session A to be discarded',
      20000
    )
    assert(!existsSync(state.aEntry.path), 'Discarded worktree directory remains')
    assert(
      execFileSync('git', ['-C', REPO_DIR, 'branch', '--list', state.aEntry.branch], { encoding: 'utf8' }).includes(
        state.aEntry.branch
      ),
      'Discard deleted the branch'
    )
    await screenshot('06-discarded')
    return { branch: state.aEntry.branch }
  })

  await step('remove a clean session and retain its branch', 'AC8', async () => {
    await selectSession(state.b.id)
    await requestRemoveSession()
    await click('[data-testid="remove-session-confirm"]')
    await waitFor(
      `!Array.from(document.querySelectorAll('[data-session-id]')).some((el) => el.innerText.includes('Worktree B'))`,
      'session B removal',
      20000
    )
    assert(!existsSync(state.bEntry.path), 'Clean worktree directory remains')
    const branches = execFileSync('git', ['-C', REPO_DIR, 'branch', '--list'], { encoding: 'utf8' })
    assert(branches.includes(state.bEntry.branch), 'Removal deleted the retained branch')
    // Retained branches live in the project maintenance dialog now, not in
    // the project header.
    const repoId = await cdp.evaluate(
      `document.querySelector('[data-testid^="project-row-"]')?.getAttribute('data-testid')?.replace('project-row-', '') ?? null`
    )
    assert(repoId, 'The project row is missing before opening maintenance')
    await click(`[data-testid="sidebar-project-menu-${repoId}"]`)
    await waitFor(`Boolean(document.querySelector('[data-testid="project-maintenance-open"]'))`, 'maintenance menu item', 10000)
    await click('[data-testid="project-maintenance-open"]')
    await waitFor(`Boolean(document.querySelector('[data-testid="project-maintenance-dialog"]'))`, 'maintenance dialog', 10000)
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid^="retained-branch-"]')).length >= 1`,
      'retained branch list'
    )
    await screenshot('07-retained-branches')
    return { branch: state.bEntry.branch }
  })

  await step('delete the retained branch explicitly', 'AC8', async () => {
    /*
     * Session removal refreshes the branch list asynchronously. The delete
     * control is deliberately disabled while the branch's old worktree path is
     * still recorded; wait for the refreshed enabled row instead of clicking a
     * disabled button and then blaming the missing notice.
     */
    await waitFor(
      `(() => {
        const row = Array.from(document.querySelectorAll('[data-testid^="retained-branch-"]')).find((el) =>
          el.getAttribute('data-testid') === ${JSON.stringify(`retained-branch-${state.bEntry.branch}`)}
        );
        const button = row && row.querySelector('button');
        return Boolean(button) && !button.disabled;
      })()`,
      'retained branch delete enabled',
      20_000
    )
    const removed = await cdp.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('[data-testid^="retained-branch-"]')).find((el) =>
        el.getAttribute('data-testid') === ${JSON.stringify(`retained-branch-${state.bEntry.branch}`)}
      );
      const button = row && row.querySelector('button');
      if (!button) return false;
      button.click();
      return true;
    })()`)
    assert(removed, 'Retained branch delete control is missing')
    await waitForNotice('deleted')
    const branches = execFileSync('git', ['-C', REPO_DIR, 'branch', '--list'], { encoding: 'utf8' })
    assert(!branches.includes(state.bEntry.branch), 'Branch still exists after deletion')
    return { branch: state.bEntry.branch }
  })

  await step('clean up without touching unrelated processes or the primary checkout', 'AC7', async () => {
    await quitApp()
    assert(hostPid && pidAlive(hostPid), 'Test host stopped before cleanup')
    try {
      process.kill(hostPid, 'SIGTERM')
    } catch {
      // already gone
    }
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && pidAlive(hostPid)) await sleep(200)
    assert(!pidAlive(hostPid), 'Test host is still running')

    assert(!existsSync(join(REPO_DIR, 'separate.txt')), 'The primary checkout was modified')
    const status = execFileSync('git', ['-C', REPO_DIR, 'status', '--porcelain'], {
      encoding: 'utf8'
    }).trim()
    assert(status === '', `Primary checkout is dirty: ${status}`)

    const lingering = []
    for (const entry of execFileSync('sh', ['-c', 'ls /proc'], { encoding: 'utf8' })
      .split('\n')
      .filter((value) => /^\d+$/.test(value))) {
      try {
        const cwd = execFileSync('readlink', [`/proc/${entry}/cwd`], { encoding: 'utf8' }).trim()
        if (cwd.startsWith(RUN_DIR)) lingering.push(Number(entry))
      } catch {
        // process vanished
      }
    }
    assert(lingering.length === 0, `Test processes still running: ${lingering.join(',')}`)
    return { hostPid, worktrees: worktreeEntries().map((entry) => entry.branch) }
  })

  RUN.finishedAt = new Date().toISOString()
  RUN.status = 'passed'
}

function expectTone(feedback) {
  assert(feedback && feedback.tone === 'error', 'Blocked removal was not reported as an error')
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
    log(`evidence: ${join(ARTIFACT_DIR, 'worktree-isolation.json')}`)
    log(`status: ${RUN.status}`)
  }
}

void run()
