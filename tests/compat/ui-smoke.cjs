'use strict'
/**
 * Real-Electron acceptance smoke for Work 6.
 *
 * Drives the product UI over CDP (no direct API calls for the user workflow),
 * against an isolated database and a detached terminal host. Screenshots and a
 * machine-readable result are written under artifacts/work6/.
 */
const { spawn, execFileSync } = require('node:child_process')
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const ELECTRON = require('electron')
const IS_WINDOWS = process.platform === 'win32'
const ARTIFACT_DIR = join(APP_DIR, 'artifacts', 'work6')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'icode-work6-smoke-'))
const REPO_DIR = join(RUN_DIR, 'repo')
const USER_DATA = join(RUN_DIR, 'userdata')
const HOST_DIR = join(RUN_DIR, 'host')
const SOCKET = join(HOST_DIR, 'terminal-host.sock')
const BROKEN_DIR = join(RUN_DIR, 'broken-host')
const EMPTY_BIN = join(RUN_DIR, 'empty-bin')

const RUN = {
  startedAt: new Date().toISOString(),
  runDir: RUN_DIR,
  steps: [],
  failures: [],
  artifacts: []
}

let appProcess = null
let cdp = null
let nextPort = 9600 + (process.pid % 300)
let repoId = null
/** Tip of the remote-only branch the first session starts from. */
let remoteBaseOid = null

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function log(message) {
  process.stdout.write(`[ui-smoke] ${message}\n`)
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


async function waitForRemovalRef(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const refs = execFileSync('git', ['-C', REPO_DIR, 'for-each-ref', 'refs/icode/removed'], {
      stdio: 'pipe'
    })
      .toString('utf8')
      .trim()
    if (refs.length > 0) return refs
    await sleep(100)
  }
  throw new Error('No recovery snapshot ref appeared under refs/icode/removed')
}

async function waitForPathGone(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(path)) return
    await sleep(100)
  }
  throw new Error(`Path still exists after removal: ${path}`)
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

async function rightClick(selector, x = null, y = null, options = {}) {
  const ctrlKey = options.ctrlKey === true
  const shiftKey = options.shiftKey === true
  const altKey = options.altKey === true
  const clicked = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const clientX = ${x === null ? 'rect.left + rect.width / 2' : String(x)};
    const clientY = ${y === null ? 'rect.top + rect.height / 2' : String(y)};
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 2,
      ctrlKey: ${ctrlKey},
      shiftKey: ${shiftKey},
      altKey: ${altKey},
      clientX,
      clientY
    }));
    return true;
  })()`, { userGesture: true })
  assert(clicked, `Could not right-click ${selector}`)
}

async function pressF11() {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'F11',
    code: 'F11',
    windowsVirtualKeyCode: 122,
    nativeVirtualKeyCode: 122
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'F11',
    code: 'F11',
    windowsVirtualKeyCode: 122,
    nativeVirtualKeyCode: 122
  })
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
  await waitForSelector('[data-testid="session-menu-popover"]', 10_000)
}

async function sessionAction(testId) {
  await openSessionMenu()
  await click(`[data-testid="${testId}"]`)
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

async function bodyText() {
  return cdp.evaluate('document.body.innerText')
}

async function notice() {
  return cdp.evaluate(`(() => {
    const element = document.querySelector('[data-testid="notice"]');
    return element ? { tone: element.dataset.tone, text: element.innerText } : null;
  })()`)
}

async function waitForNotice(needle, timeoutMs = 15000) {
  await waitFor(
    `(() => { const n = document.querySelector('[data-testid="notice"]'); return Boolean(n && n.innerText.includes(${JSON.stringify(needle)})); })()`,
    `notice containing ${needle}`,
    timeoutMs
  )
  return notice()
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
        incarnation: element.dataset.sessionIncarnation,
        text: element.innerText
      });
    }
    return Array.from(byId.values());
  })()`)
}

async function sessionByTitle(title) {
  const list = await sessions()
  return list.find((entry) => entry.text.split('\n')[0] === title) ?? null
}

/**
 * Project groups start collapsed: the project list is visible, but no project
 * children render. Assert that launch default before a test expands anything.
 */
async function assertProjectsCollapsed() {
  const state = await cdp.evaluate(`(() => {
    const sidebar = document.querySelector('[data-testid="workspace-sidebar"]');
    const toggles = sidebar === null
      ? []
      : Array.from(sidebar.querySelectorAll('[data-testid^="sidebar-project-toggle-"]'));
    return {
      toggles: toggles.length,
      collapsed: toggles.every((element) => element.getAttribute('aria-expanded') === 'false'),
      children: sidebar !== null && Boolean(sidebar.querySelector('[data-testid^="sidebar-default-checkout-"]')),
      sessions: sidebar !== null && Boolean(sidebar.querySelector('[data-testid^="sidebar-project-group-"] [data-session-id]'))
    };
  })()`)
  assert(state.toggles > 0, 'The sidebar has project rows but no expansion toggles')
  assert(state.collapsed, 'Project groups did not start collapsed')
  assert(!state.children, 'Project children rendered before expansion')
  assert(!state.sessions, 'Project-group session rows rendered before expansion')
}

/** Expand every collapsed project group so sidebar children are in the DOM. */
async function expandAllProjects() {
  await waitFor(
    `Boolean(document.querySelector('[data-testid^="sidebar-project-toggle-"]')) || Boolean(document.querySelector('[data-testid="empty-workspace"]'))`,
    'project expansion toggles',
    20000
  )
  await cdp.evaluate(`(() => {
    for (const toggle of document.querySelectorAll('[data-testid^="sidebar-project-toggle-"][aria-expanded="false"]')) toggle.click()
  })()`)
  await waitFor(
    `document.querySelectorAll('[data-testid^="sidebar-project-toggle-"][aria-expanded="false"]').length === 0`,
    'projects expanded',
    5000
  )
}

async function openProjectSessions() {
  await expandAllProjects()
  if (
    await cdp.evaluate(`Boolean(document.querySelector('[data-testid="sessions-surface"]'))`)
  ) {
    return
  }
  await waitForSelector('[data-testid^="project-row-"]', 20000)
  if (repoId === null) {
    repoId = await cdp.evaluate(
      `document.querySelector('[data-testid^="project-row-"]')?.getAttribute('data-testid')?.replace('project-row-', '') ?? null`
    )
  }
  assert(repoId, 'Could not identify the registered repository lane')
  await click(`[data-testid="project-row-${repoId}"]`)
  await waitForSelector('[data-testid="sessions-surface"]', 20000)
}

async function openProjectMenu(repoId) {
  await waitForSelector('[data-testid^="project-row-"]', 20000)
  await click(`[data-testid="sidebar-project-menu-${repoId}"]`)
  await waitForSelector('[data-testid="sidebar-project-menu"]', 20000)
}

async function removeRepositoryFromSidebar(repoId) {
  await openProjectMenu(repoId)
  await click(`[data-testid="repository-remove-${repoId}"]`)
  await waitForSelector('[data-testid="remove-repository-dialog"]', 10000)
  await click('[data-testid="confirm-remove-repo"]')
}

async function activeState() {
  return cdp.evaluate(`(() => {
    const badge = document.querySelector('[data-testid="session-state"]');
    return badge ? {
      text: badge.innerText,
      state: badge.getAttribute('data-state'),
      authority: badge.getAttribute('data-authority'),
      reason: badge.getAttribute('data-reason'),
      title: document.querySelector('[data-testid="session-title"]')?.innerText,
      incarnation: document.querySelector('[data-testid="session-incarnation"]')?.innerText
    } : null;
  })()`)
}

async function panes() {
  return cdp.evaluate(`Array.from(document.querySelectorAll('[data-testid^="terminal-pane-"]')).map((element) => ({
    id: element.getAttribute('data-testid'),
    phase: element.getAttribute('data-phase'),
    active: element.getAttribute('data-active')
  }))`)
}

async function rows(sessionId) {
  return cdp.evaluate(`(() => {
    const pane = document.querySelector('[data-testid="terminal-pane-${sessionId}"]');
    if (!pane) return [];
    return Array.from(pane.querySelectorAll('.xterm-rows > div')).map((row) => row.textContent);
  })()`)
}

async function focusTerminal(sessionId) {
  const focused = await cdp.evaluate(`(() => {
    const pane = document.querySelector('[data-testid="terminal-pane-${sessionId}"]');
    const textarea = pane && pane.querySelector('.xterm-helper-textarea');
    if (!textarea) return false;
    textarea.focus();
    return document.activeElement === textarea;
  })()`)
  assert(focused, `Terminal for ${sessionId} could not take focus`)
}

async function pressEnter() {
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
}

async function pressEscape() {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
}

async function typeInSession(sessionId, text, waitMs = 700) {
  await focusTerminal(sessionId)
  await cdp.send('Input.insertText', { text })
  await pressEnter()
  await sleep(waitMs)
  return rows(sessionId)
}

async function waitForState(state, timeoutMs = 15000) {
  return waitFor(
    `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === ${JSON.stringify(state)}`,
    `session state ${state}`,
    timeoutMs
  )
}

async function waitForTerminalLine(sessionId, predicate, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await rows(sessionId)
    if (last.some((line, index) => predicate(line, index, last))) return last
    await sleep(150)
  }
  throw new Error(
    `Timed out waiting for ${description} in the terminal (last rows: ${JSON.stringify(last.slice(-14))})`
  )
}

async function pointForTerminalText(sessionId, text) {
  return cdp.evaluate(`(() => {
    const pane = document.querySelector('[data-testid="terminal-pane-${sessionId}"]');
    if (!pane) return null;
    const row = Array.from(pane.querySelectorAll('.xterm-rows > div'))
      .find((entry) => entry.textContent.includes(${JSON.stringify(text)}));
    if (!row) return null;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent.indexOf(${JSON.stringify(text)});
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index + Math.min(8, ${JSON.stringify(text)}.length) - 1);
      range.setEnd(node, index + Math.min(8, ${JSON.stringify(text)}.length));
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return null;
  })()`)
}

async function clickPoint(position) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: position.x,
    y: position.y
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: position.x,
    y: position.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: position.x,
    y: position.y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
}

/**
 * Real right-button input, so xterm's mousedown/mouseup reporting is exercised
 * (the synthetic contextmenu helper cannot test PTY suppression).
 */
async function rightClickPoint(position, modifiers = 0) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: position.x,
    y: position.y,
    button: 'right',
    buttons: 2,
    clickCount: 1,
    modifiers
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: position.x,
    y: position.y,
    button: 'right',
    buttons: 0,
    clickCount: 1,
    modifiers
  })
}

/** Real left click on a selector, for clipboard calls that need user activation. */
async function clickSelectorWithMouse(selector) {
  const point = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  assert(point, `Could not locate ${selector}`)
  await clickPoint(point)
}

/** Reads the clipboard when Electron grants it; null means the probe was denied. */
async function readClipboardText() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const text = await cdp.evaluate(`navigator.clipboard.readText().catch(() => null)`)
    if (typeof text === 'string' && text.length > 0) return text
    await sleep(100)
  }
  return null
}

function requireElectron() {
  assert(typeof ELECTRON === 'string' && existsSync(ELECTRON), 'Electron binary not found')
}

function prepareRunDir() {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  mkdirSync(REPO_DIR, { recursive: true })
  mkdirSync(USER_DATA, { recursive: true })
  // The smoke asserts English copy; pin the isolated profile so a non-English
  // system locale cannot fail the run before it starts.
  writeFileSync(join(USER_DATA, 'preferences.json'), '{"locale":"en"}\n')
  mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(EMPTY_BIN, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: REPO_DIR })
  writeFileSync(join(REPO_DIR, 'README.md'), '# iCode Work 6 smoke\n')
  execFileSync('git', ['add', 'README.md'], { cwd: REPO_DIR })
  execFileSync(
    'git',
    ['-c', 'user.email=icode@example.test', '-c', 'user.name=iCode', 'commit', '-qm', 'init'],
    { cwd: REPO_DIR }
  )
  // A remote-only branch proves Start-from lists and fetches refs/remotes.
  const originRepo = join(RUN_DIR, 'origin.git')
  execFileSync('git', ['init', '--bare', '-q', originRepo], { cwd: RUN_DIR })
  execFileSync('git', ['remote', 'add', 'origin', originRepo], { cwd: REPO_DIR })
  execFileSync('git', ['checkout', '-q', '-b', 'smoke/remote-base'], { cwd: REPO_DIR })
  writeFileSync(join(REPO_DIR, 'remote-base.txt'), 'remote baseline\n')
  execFileSync('git', ['add', 'remote-base.txt'], { cwd: REPO_DIR })
  execFileSync(
    'git',
    ['-c', 'user.email=icode@example.test', '-c', 'user.name=iCode', 'commit', '-qm', 'remote base'],
    { cwd: REPO_DIR }
  )
  remoteBaseOid = execFileSync('git', ['-C', REPO_DIR, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  execFileSync('git', ['push', '-q', 'origin', 'smoke/remote-base'], { cwd: REPO_DIR })
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: REPO_DIR })
  writeFileSync(BROKEN_DIR, 'not a directory\n')
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
  await waitForSelector('[data-testid="workspace-sidebar"]', 30000)
  await waitFor(
    `Boolean(document.querySelector('[data-testid^="project-row-"]')) || Boolean(document.querySelector('[data-testid="empty-workspace"]'))`,
    'workspace shell',
    30000
  )
  await waitFor(
    `!document.body.innerText.includes('Loading repositories')`,
    'workspace boot',
    30000
  )
  if (await cdp.evaluate(`Boolean(document.querySelector('[data-testid^="project-row-"]'))`)) {
    await assertProjectsCollapsed()
    await expandAllProjects()
  }
  return port
}

async function quitApp() {
  if (!cdp) return
  const port = cdp.port
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
    await sleep(1500)
  }
  try {
    cdp.close()
  } catch {
    // Already closed.
  }
  cdp = null
  appProcess = null
  if (port) await sleep(250)
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

/**
 * The host endpoint must be derived on Windows: `listen()` only accepts a
 * named pipe there, and an explicit POSIX-style path fails with EACCES. The
 * POSIX runs pin the socket under the isolated host directory.
 */
function hostEnv(extra = {}) {
  return {
    ICODE_HOST_DIR: HOST_DIR,
    ...(IS_WINDOWS ? {} : { ICODE_HOST_SOCKET: SOCKET }),
    ...extra
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main() {
  requireElectron()
  prepareRunDir()
  RUN.environment = {
    electron: ELECTRON,
    repo: REPO_DIR,
    userData: USER_DATA,
    hostDir: HOST_DIR,
    socket: SOCKET,
    platform: process.platform,
    node: process.version
  }

  let port = nextPort++

  await step('boot empty workspace and detect Harnesses', async () => {
    await launch('initial', hostEnv(), port)
    const empty = await bodyText()
    assert(empty.includes('Add a project'), 'First-run empty state is missing')
    assert((await sessions()).length === 0, 'Expected no sessions on first run')
    await screenshot('01-empty-workspace')
    return { port }
  })

  await step('register a real local Git repository through the dialog', async () => {
    await click('[data-testid="empty-add-repo"]')
    await waitForSelector('[data-testid="add-repo-input"]')
    await setInput('[data-testid="add-repo-input"]', REPO_DIR)
    await click('[data-testid="add-repo-submit"]')
    await waitForNotice('Registered')
    await waitForSelector('[data-testid^="project-row-"]', 20000)
    repoId = await cdp.evaluate(
      `document.querySelector('[data-testid^="project-row-"]')?.getAttribute('data-testid')?.replace('project-row-', '') ?? null`
    )
    assert(repoId, 'Registered repository row is missing')
    await waitForSelector('[data-testid="sidebar-project-rows"]')
    await assertProjectsCollapsed()
    await screenshot('02a-project-sidebar')

    await click(`[data-testid="sidebar-project-menu-${repoId}"]`)
    await waitForSelector(`[data-testid="pin-project-${repoId}"]`, 10000)
    await click(`[data-testid="pin-project-${repoId}"]`)
    await waitForSelector('[data-testid="sidebar-pinned"]', 5000)
    await screenshot('02b-pinned-project')

    await click('[data-testid="global-search"]')
    await waitForSelector('[data-testid="command-palette"]')
    await setInput('[data-testid="command-palette-input"]', 'repo')
    await waitFor(
      `document.querySelectorAll('[data-testid="command-palette-item"][data-kind="project"]').length >= 1`,
      'project search result',
      5000
    )
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    })

    await openProjectSessions()
    const text = await bodyText()
    assert(text.includes('No direct sessions in'), 'Repository workspace did not load')
    await screenshot('02-repository-registered')
    return { notice: await notice() }
  })

  await step('show the default checkout container without creating a session', async () => {
    await waitForSelector(`[data-testid="sidebar-default-checkout-${repoId}"]`, 10000)
    const text = await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-default-checkout-${repoId}"]')?.textContent ?? ''`
    )
    assert(text.includes('Default checkout'), 'Default checkout container label is missing')
    assert((await sessions()).length === 0, 'Adding a project must not auto-create a session')

    await click(`[data-testid="sidebar-default-checkout-new-session-${repoId}"]`)
    await waitForSelector('[data-testid="new-session-worktree"]', 5000)
    const choice = await cdp.evaluate(
      `document.querySelector('[data-testid="new-session-worktree"]')?.value ?? null`
    )
    assert(choice === 'default', 'Default checkout action did not preselect the shared checkout')

    // Run one shell session in the shared checkout, prove it owns no worktree,
    // then remove it so the remaining steps keep their two-session expectations.
    await click('[data-testid="harness-option-shell"]')
    await click('[data-testid="create-session-submit"]')
    let created = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && created === null) {
      const listed = await cdp.evaluate(
        `window.icode.sessions.list({ repoId: ${JSON.stringify(repoId)} })`
      )
      created = listed?.ok
        ? (listed.value.sessions.find((session) => session.worktree === null) ?? null)
        : null
      if (created === null) await sleep(250)
    }
    assert(created, 'The default checkout session did not appear without a worktree')
    assert(created.state !== 'failed', `Default checkout session failed: ${JSON.stringify(created)}`)
    await waitFor(
      `document.querySelector('[data-testid="session-state"]')?.dataset.state === 'live'`,
      'default checkout session live',
      30000
    )
    await click('[data-testid="view-files"]')
    await waitForSelector('[data-testid="files-entry-README.md"]', 15000)
    await click('[data-testid="view-changes"]')
    await waitForSelector('[data-testid="changes-default-checkout-banner"]', 15000)
    await waitFor(
      `document.querySelector('[data-testid="changes-panel"]')?.dataset.phase === 'ready'`,
      'default checkout Source Control ready',
      15000
    )
    await screenshot('02c-default-checkout-session')

    const removed = await cdp.evaluate(
      `window.icode.sessions.remove({ sessionId: ${JSON.stringify(created.id)}, stopIfLive: true })`
    )
    assert(removed?.ok, `Default checkout session removal failed: ${JSON.stringify(removed)}`)
    // The direct IPC call bypasses the renderer's remove action, so refresh the
    // sidebar before asserting the row is gone.
    await click('[data-testid="sidebar-refresh"]')
    await waitFor(
      `!document.querySelector('[data-session-id="${created.id}"]')`,
      'default checkout session removed',
      15000
    )
    const remaining = await cdp.evaluate(
      `window.icode.sessions.list({ repoId: ${JSON.stringify(repoId)} })`
    )
    assert(
      remaining?.ok && remaining.value.sessions.length === 0,
      'Removing the default checkout session must not leave a worktree session behind'
    )
    return { text, sessionId: created.id }
  })

  await step('keep the custom window title bar truthful at the minimum width', async () => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 760,
      height: 480,
      deviceScaleFactor: 1,
      mobile: false
    })
    await sleep(300)
    const info = await cdp.evaluate(`(() => {
      const brand = document.querySelector('[data-testid="sidebar-brand"]');
      const titlebar = brand?.closest('.icode-titlebar');
      const controls = [...document.querySelectorAll('button[data-testid^="window-"]')];
      const clipped = controls.filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1;
      });
      return {
        viewport: { width: innerWidth, height: innerHeight },
        titlebarHeight: titlebar ? Math.round(titlebar.getBoundingClientRect().height) : 0,
        controls: controls.length,
        clipped: clipped.map((button) => button.getAttribute('data-testid')),
        drag: titlebar ? getComputedStyle(titlebar).getPropertyValue('-webkit-app-region').trim() : 'missing',
        closeDrag: getComputedStyle(document.querySelector('[data-testid="window-close"]')).getPropertyValue('-webkit-app-region').trim()
      };
    })()`)
    assert(info.controls === 3, `Expected three window controls, got ${String(info.controls)}`)
    assert(info.clipped.length === 0, `Window controls overflow at 760x480: ${JSON.stringify(info)}`)
    assert(info.drag === 'drag', `Sidebar titlebar is not a drag region: ${JSON.stringify(info)}`)
    assert(info.closeDrag === 'no-drag', `Close button is not a no-drag target: ${JSON.stringify(info)}`)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(300)

    const before = await cdp.evaluate('window.icode.window.isMaximized()')
    assert(before.ok, `isMaximized failed: ${JSON.stringify(before)}`)
    const expected = !before.value
    await click('[data-testid="window-toggle"]')
    await waitFor(
      `document.querySelector('[data-testid="window-toggle"]')?.getAttribute('aria-pressed') === '${String(expected)}'`,
      'window maximize state',
      5000
    )
    await click('[data-testid="window-toggle"]')
    await waitFor(
      `document.querySelector('[data-testid="window-toggle"]')?.getAttribute('aria-pressed') === '${String(before.value)}'`,
      'window restore state',
      5000
    )
    return { ...info, maximized: before.value }
  })

  await step('inspect real Harness detection and reject unavailable Harnesses', async () => {
    await click('[data-testid="empty-new-session"]')
    await waitForSelector('[data-testid="harness-list"]')
    // The dialog lists installed Harnesses; everything else sits behind
    // "More agents", so expand it to inspect the whole detection.
    await waitFor(
      `document.querySelectorAll('[data-harness-state]').length >= 1`,
      'installed Harness detections',
      20000
    )
    await cdp.evaluate(`(() => {
      const button = document.querySelector('[data-testid="harness-more"]');
      if (button) button.click();
    })()`)
    await waitFor(
      `document.querySelectorAll('[data-harness-state]').length === 46`,
      'all Harness detections',
      20000
    )
    const states = await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-harness-state]')).map((element) => ({
        harness: element.getAttribute('data-testid').replace('harness-option-', ''),
        state: element.getAttribute('data-harness-state'),
        selected: element.getAttribute('data-selected'),
        disabled: element.disabled,
        text: element.innerText
      }))`
    )
    const shell = states.find((entry) => entry.harness === 'shell')
    assert(shell && shell.state === 'available', 'Shell Harness is not available')
    for (const entry of states.filter((item) => item.state !== 'available')) {
      assert(entry.disabled, `Unavailable Harness ${entry.harness} is selectable`)
    }
    await screenshot('03-harness-detection')
    return { states }
  })

  const firstTitle = 'Smoke shell one'
  let firstSession = null
  let firstPid = null

  await step('create a Shell session and interact with the real PTY', async () => {
    await click('[data-testid="harness-option-shell"]')
    await setInput('[data-testid="session-title-input"]', firstTitle)
    await waitFor(
      `(() => {
        const select = document.querySelector('[data-testid="new-session-start-from"]');
        return Boolean(
          select &&
          !select.disabled &&
          Array.from(select.options).some(
            (option) => option.value === 'refs/remotes/origin/smoke/remote-base'
          )
        );
      })()`,
      'remote Start-from option',
      15000
    )
    const remoteOption = await cdp.evaluate(`(() => {
      const select = document.querySelector('[data-testid="new-session-start-from"]');
      const option = select && Array.from(select.options).find(
        (entry) => entry.value === 'refs/remotes/origin/smoke/remote-base'
      );
      return option ? { text: option.innerText, group: option.parentElement?.tagName ?? null } : null;
    })()`)
    assert(remoteOption, 'Remote branch is missing from Start from')
    assert(remoteOption.group === 'OPTGROUP', 'Remote branch is not grouped')
    await setSelect(
      '[data-testid="new-session-start-from"]',
      'refs/remotes/origin/smoke/remote-base'
    )
    await click('[data-testid="create-session-submit"]')
    await waitFor(
      `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === 'live'`,
      'first session live',
      20000
    )
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid^="terminal-pane-"]')).some((pane) => pane.getAttribute('data-phase') === 'live' && pane.getAttribute('data-active') === 'true')`,
      'live terminal pane',
      20000
    )
    firstSession = await sessionByTitle(firstTitle)
    assert(firstSession && firstSession.incarnation, 'First session has no incarnation')
    const listed = await cdp.evaluate(
      `window.icode.sessions.list({ repoId: ${JSON.stringify(repoId)} })`
    )
    const listedSession =
      listed && listed.ok
        ? listed.value.sessions.find((entry) => entry.title === firstTitle)
        : null
    assert(listedSession && listedSession.worktree, 'Created session has no worktree')
    assert(
      execFileSync('git', ['-C', listedSession.worktree.path, 'rev-parse', 'HEAD'], {
        encoding: 'utf8'
      }).trim() === remoteBaseOid,
      'Worktree HEAD did not use the remote branch tip'
    )
    let upstream = null
    try {
      upstream = execFileSync(
        'git',
        ['-C', listedSession.worktree.path, 'config', '--get', `branch.${listedSession.worktree.branch}.remote`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
    } catch {
      upstream = null
    }
    assert(upstream === null, 'Generated session branch unexpectedly tracks the remote')
    await waitForTerminalLine(
      firstSession.id,
      (line) => /\$\s*$/.test(line),
      'the shell prompt before typing'
    )
    await typeInSession(
      firstSession.id,
      'export ICODE_SMOKE=first; echo FIRST_PID=$$; echo FIRST_READY'
    )
    const output = await waitForTerminalLine(
      firstSession.id,
      (line) => /^FIRST_PID=\d+$/.test(line.trim()),
      'the PTY pid line'
    )
    const match = /^FIRST_PID=(\d+)$/m.exec(output.join('\n'))
    assert(match, 'Could not read the PTY pid from the shell')
    firstPid = Number(match[1])
    await waitForTerminalLine(
      firstSession.id,
      (line) => line.trim() === 'FIRST_READY',
      'the first command completion'
    )
    await screenshot('04-first-session-output')
    return { session: firstSession, pid: firstPid }
  })

  await step('open terminal find and the pane context menu', async () => {
    const terminal = `[data-testid="terminal-${firstSession.id}"]`
    await rightClick(terminal, 40, 40)
    await waitForSelector('[data-testid="terminal-context-menu"]')
    const copyDisabled = await cdp.evaluate(
      `document.querySelector('[data-testid="terminal-menu-copy"]')?.getAttribute('aria-disabled')`
    )
    assert(copyDisabled === 'true', 'Copy should be disabled without a selection')

    // Copy Screen Content is the always-available fallback.
    await clickSelectorWithMouse('[data-testid="terminal-menu-copy-screen"]')
    await waitFor(
      `!document.querySelector('[data-testid="terminal-context-menu"]')`,
      'terminal menu closed after Copy Screen Content'
    )
    await waitFor(
      `(document.querySelector('[data-testid="notice"]')?.textContent ?? '').includes('screen content')`,
      'Copy Screen Content notice',
      5000
    )
    const screenClipboard = await readClipboardText()
    assert(
      screenClipboard === null || screenClipboard.includes('FIRST_READY'),
      `Copy Screen Content clipboard: ${JSON.stringify(screenClipboard)}`
    )

    // Select All gives xterm a selection; a plain right-click must copy
    // instead of opening the menu.
    await rightClick(terminal, 40, 40)
    await waitForSelector('[data-testid="terminal-context-menu"]')
    await click('[data-testid="terminal-menu-select-all"]')
    await sleep(150)
    const copyPoint = await pointForTerminalText(firstSession.id, 'FIRST_READY')
    assert(copyPoint, 'Could not locate the line to copy')
    await rightClickPoint(copyPoint)
    await rightClick(terminal, copyPoint.x, copyPoint.y)
    await waitFor(
      `(document.querySelector('[data-testid="notice"]')?.textContent ?? '').includes('selection')`,
      'right-click copy notice',
      5000
    )
    const menuAfterCopy = await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="terminal-context-menu"]'))`
    )
    assert(
      menuAfterCopy === false,
      'A plain right-click with a selection opened the menu instead of copying'
    )
    const selectionClipboard = await readClipboardText()
    assert(
      selectionClipboard === null || selectionClipboard.includes('FIRST_READY'),
      `Right-click copy clipboard: ${JSON.stringify(selectionClipboard)}`
    )

    // Ctrl+right-click always opens the menu.
    await rightClick(terminal, 40, 40, { ctrlKey: true })
    await waitForSelector('[data-testid="terminal-context-menu"]')
    const copyEnabled = await cdp.evaluate(
      `document.querySelector('[data-testid="terminal-menu-copy"]')?.getAttribute('aria-disabled')`
    )
    assert(copyEnabled === 'false', 'Copy should be enabled after Select All')
    await click('[data-testid="terminal-menu-find"]')
    await waitForSelector('[data-testid="terminal-find-bar"]')
    const placeholder = await cdp.evaluate(
      `document.querySelector('[data-testid="terminal-find-bar"] input')?.getAttribute('placeholder')`
    )
    assert(placeholder, 'Terminal find input is missing')
    await cdp.send('Input.insertText', { text: 'FIRST_READY' })
    await sleep(250)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    })
    await waitFor(
      `!document.querySelector('[data-testid="terminal-find-bar"]')`,
      'terminal find closed'
    )
    await screenshot('04b-terminal-find-menu')
    return { placeholder }
  })

  await step('open a terminal URL through the link popover', async () => {
    const url = 'https://example.com/icode-link'
    await typeInSession(firstSession.id, `echo ${url}`)
    await waitForTerminalLine(
      firstSession.id,
      (line) => line.includes(url),
      'the printed URL'
    )
    // The find step above selected all; a plain click clears it so the link
    // gesture is not rejected as a selection click.
    const blank = await cdp.evaluate(`(() => {
      const screen = document.querySelector('[data-testid="terminal-pane-${firstSession.id}"] .xterm-screen');
      if (!screen) return null;
      const rect = screen.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.bottom - 10 };
    })()`)
    assert(blank, 'Could not locate the terminal screen')
    await clickPoint(blank)
    await sleep(150)
    const point = await pointForTerminalText(firstSession.id, url)
    assert(point, 'Could not locate the URL cell')
    await clickPoint(point)
    await waitForSelector('[data-testid="terminal-link-popover"]')
    await screenshot('04c-terminal-link-popover')
    await click('[data-testid="terminal-link-copy"]')
    await waitFor(
      `!document.querySelector('[data-testid="terminal-link-popover"]')`,
      'terminal link popover closed by Copy Link'
    )

    // Escape is the other dismissal path; do not open the system browser.
    await clickPoint(point)
    await waitForSelector('[data-testid="terminal-link-popover"]')
    await sleep(150)
    const escapeTarget = await cdp.evaluate(`(() => {
      const element = document.activeElement;
      return element
        ? {
            tag: element.tagName,
            testId: element.getAttribute('data-testid'),
            className: String(element.className).slice(0, 120)
          }
        : null;
    })()`)
    assert(
      escapeTarget?.testId === 'terminal-link-open',
      `Escape would target ${JSON.stringify(escapeTarget)}, not the link popover`
    )
    await pressEscape()
    await waitFor(
      `!document.querySelector('[data-testid="terminal-link-popover"]')`,
      'terminal link popover closed by Escape'
    )
    return { url }
  })

  await step('open a URL in a mouse-aware TUI without leaking the click', async () => {
    const url = 'https://example.com/tui-link'
    const command =
      "printf '\\033[?1000h\\033[?1006h'; " +
      `echo ${url}; ` +
      'if IFS= read -t 10 -r -n 1 ch; then ' +
      "if [ \"$ch\" = $'\\033' ]; then echo TUI_GOT_CLICK; else echo TUI_NO_CLICK; fi; " +
      'else echo TUI_NO_CLICK; fi; ' +
      "printf '\\033[?1000l\\033[?1006l'"
    await typeInSession(firstSession.id, command)
    await waitForTerminalLine(
      firstSession.id,
      (line) => line.includes(url),
      'the URL in the mouse-aware session'
    )
    const point = await pointForTerminalText(firstSession.id, url)
    assert(point, 'Could not locate the mouse-aware URL cell')
    await clickPoint(point)
    await waitForSelector('[data-testid="terminal-link-popover"]')
    await screenshot('04d-terminal-link-tui-popover')

    const escapeTarget = await cdp.evaluate(
      `document.activeElement?.getAttribute('data-testid') ?? null`
    )
    assert(
      escapeTarget === 'terminal-link-open',
      `Escape would target ${escapeTarget ?? 'no element'}, not the link popover`
    )
    await pressEscape()
    await waitFor(
      `!document.querySelector('[data-testid="terminal-link-popover"]')`,
      'terminal link popover closed after the TUI click'
    )

    // End the shell's read and collect its verdict. The click must not have
    // arrived as a PTY mouse report.
    await focusTerminal(firstSession.id)
    await pressEnter()
    const verdict = await waitForTerminalLine(
      firstSession.id,
      (line) => line.trim() === 'TUI_NO_CLICK' || line.trim() === 'TUI_GOT_CLICK',
      'the TUI mouse-report verdict'
    )
    assert(
      verdict.some((line) => line.trim() === 'TUI_NO_CLICK'),
      `The TUI received the link click: ${JSON.stringify(verdict.slice(-8))}`
    )
    await waitForTerminalLine(
      firstSession.id,
      (line) => /\$\s*$/.test(line),
      'the shell prompt after the mouse-aware click'
    )
    return { url, verdict: 'no-pty-mouse-report' }
  })

  await step('right-click in a mouse-aware TUI stays with iCode', async () => {
    const terminal = `[data-testid="terminal-${firstSession.id}"]`
    const rightCommand =
      "printf '\\033[?1000h\\033[?1006h'; " +
      'echo TUI_RIGHT_TARGET; ' +
      'if IFS= read -t 5 -r -n 1 ch; then ' +
      "if [ \"$ch\" = $'\\033' ]; then echo TUI_GOT_RIGHT; else echo TUI_NO_RIGHT; fi; " +
      'else echo TUI_NO_RIGHT; fi; ' +
      'if IFS= read -t 0.5 -r -n 64 rest; then :; fi; ' +
      "printf '\\033[?1000l\\033[?1006l'; echo TUI_RIGHT_DONE"
    await typeInSession(firstSession.id, rightCommand)
    await waitForTerminalLine(
      firstSession.id,
      (line) => line.includes('TUI_RIGHT_TARGET'),
      'the TUI right-click target'
    )
    const point = await pointForTerminalText(firstSession.id, 'TUI_RIGHT_TARGET')
    assert(point, 'Could not locate the TUI right-click target')
    await rightClickPoint(point)
    await rightClick(terminal, point.x, point.y)
    await waitForSelector('[data-testid="terminal-context-menu"]')
    const hint = await cdp.evaluate(
      `document.querySelector('[data-testid="terminal-menu-copy-hint"]')?.textContent ?? ''`
    )
    assert(hint.length > 0, 'TUI right-click menu is missing the selection hint')
    const copyDisabled = await cdp.evaluate(
      `document.querySelector('[data-testid="terminal-menu-copy"]')?.getAttribute('aria-disabled')`
    )
    assert(copyDisabled === 'true', 'Copy should be disabled without an xterm selection')
    const copyScreen = await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="terminal-menu-copy-screen"]'))`
    )
    assert(copyScreen, 'TUI right-click menu is missing Copy Screen Content')
    await pressEscape()
    await waitFor(
      `!document.querySelector('[data-testid="terminal-context-menu"]')`,
      'TUI right-click menu closed'
    )
    await focusTerminal(firstSession.id)
    await pressEnter()
    const rightVerdict = await waitForTerminalLine(
      firstSession.id,
      (line) => line.trim() === 'TUI_NO_RIGHT' || line.trim() === 'TUI_GOT_RIGHT',
      'the TUI right-click verdict'
    )
    assert(
      rightVerdict.some((line) => line.trim() === 'TUI_NO_RIGHT'),
      `The TUI received the right click: ${JSON.stringify(rightVerdict.slice(-8))}`
    )
    await waitForTerminalLine(
      firstSession.id,
      (line) => line.trim() === 'TUI_RIGHT_DONE',
      'the TUI right-click cleanup'
    )

    // The shared suppression option must be restored: a left click still reaches the TUI.
    const leftCommand =
      "printf '\\033[?1000h\\033[?1006h'; " +
      'echo TUI_LEFT_TARGET; ' +
      'if IFS= read -t 5 -r -n 1 ch; then ' +
      "if [ \"$ch\" = $'\\033' ]; then echo TUI_LEFT_GOT; else echo TUI_LEFT_NONE; fi; " +
      'else echo TUI_LEFT_NONE; fi; ' +
      'if IFS= read -t 0.5 -r -n 64 rest; then :; fi; ' +
      "printf '\\033[?1000l\\033[?1006l'; echo TUI_LEFT_DONE"
    await typeInSession(firstSession.id, leftCommand)
    await waitForTerminalLine(
      firstSession.id,
      (line) => line.includes('TUI_LEFT_TARGET'),
      'the TUI left-click target'
    )
    const leftPoint = await pointForTerminalText(firstSession.id, 'TUI_LEFT_TARGET')
    assert(leftPoint, 'Could not locate the TUI left-click target')
    await clickPoint(leftPoint)
    // Let the report end the read before Enter can be mistaken for it.
    await sleep(200)
    await focusTerminal(firstSession.id)
    await pressEnter()
    await screenshot('04e-tui-left-click-verdict')
    const leftVerdict = await waitForTerminalLine(
      firstSession.id,
      (line) => line.trim().endsWith('TUI_LEFT_GOT') || line.trim().endsWith('TUI_LEFT_NONE'),
      'the TUI left-click verdict'
    )
    assert(
      leftVerdict.some((line) => line.trim().endsWith('TUI_LEFT_GOT')),
      'TUI mouse reporting stayed suppressed after the right click'
    )
    await waitForTerminalLine(
      firstSession.id,
      (line) => line.trim() === 'TUI_LEFT_DONE',
      'the TUI left-click cleanup'
    )
    return { right: 'no-pty-right-report', left: 'pty-report-restored' }
  })

  await step('resize the terminal through the visible UI and typed API', async () => {
    const parseSize = (list) => {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(list[index] ?? '')
        if (match) return { rows: Number(match[1]), cols: Number(match[2]) }
      }
      return null
    }
    const before = parseSize(await typeInSession(firstSession.id, 'stty size; echo SIZE_BEFORE'))
    assert(before, 'Could not read terminal size before resize')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1000,
      height: 620,
      deviceScaleFactor: 1,
      mobile: false
    })
    await sleep(900)
    const after = parseSize(await typeInSession(firstSession.id, 'stty size; echo SIZE_AFTER'))
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(600)
    assert(after, 'Could not read terminal size after resize')
    assert(
      before.cols !== after.cols,
      `Terminal width did not change (${before.cols} -> ${after.cols})`
    )
    await screenshot('05-terminal-resized')
    return { before, after }
  })

  await step('give the terminal more room and restore the workspace', async () => {
    const terminalRect = () => cdp.evaluate(`(() => {
      const rect = document.querySelector('[data-testid^="terminal-"]')?.getBoundingClientRect();
      return rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null;
    })()`)
    // Measure with the inspector open; a narrow CI display may have started it collapsed.
    await cdp.evaluate(`(() => {
      document.querySelector('[data-testid="inspector-expand"]')?.click();
      return true;
    })()`)
    await sleep(300)
    const normal = await terminalRect()
    assert(normal, 'Terminal pane was not measurable')

    await click('[data-testid="inspector-collapse"]')
    await waitForSelector('[data-testid="inspector-expand"]', 10_000)
    const withoutList = await terminalRect()
    assert(
      withoutList && withoutList.width > normal.width + 250,
      `Collapsing the inspector did not widen the terminal (${normal?.width} -> ${withoutList?.width})`
    )

    await pressF11()
    await waitFor(
      `!document.querySelector('[data-testid="global-search"]') &&
       !document.querySelector('[data-testid="workspace-sidebar"]') &&
       !document.querySelector('[data-testid="app-tabs"]') &&
       !document.querySelector('[data-testid="window-controls"]') &&
       !document.querySelector('[data-testid="session-tabs"]') &&
       !document.querySelector('[data-testid="session-inspector"]') &&
       !document.querySelector('[data-testid="session-header"]')`,
      'focus mode to hide the surrounding chrome',
      10_000
    )
    const focused = await terminalRect()
    assert(
      focused &&
        focused.width > withoutList.width + 40 &&
        focused.height > normal.height + 70,
      `Focus mode did not expand the terminal (${JSON.stringify({ normal, withoutList, focused })})`
    )
    await screenshot('04b-terminal-expanded')

    await pressF11()
    await waitFor(
      `Boolean(document.querySelector('[data-testid="global-search"]')) &&
       Boolean(document.querySelector('[data-testid="workspace-sidebar"]')) &&
       Boolean(document.querySelector('[data-testid="sessions-surface"]'))`,
      'F11 to leave focus mode',
      10_000
    )
    // Clear any partial line a function key may have left in the shell.
    await typeInSession(firstSession.id, '\u0003')

    // Restore the inspector for the remaining multi-session steps.
    await click('[data-testid="inspector-expand"]')
    await waitForSelector('[data-testid="inspector-collapse"]', 10_000)
    return { normal, withoutList, focused }
  })

  await step('keep the one-line session header inside the viewport', async () => {
    const measure = async (width, height) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      })
      await sleep(500)
      return cdp.evaluate(`(() => {
        const header = document.querySelector('[data-testid="session-header"]');
        const terminal = document.querySelector('[data-testid^="terminal-"]');
        if (!header || !terminal) return null;
        const headerRect = header.getBoundingClientRect();
        const buttons = [...header.querySelectorAll('button')];
        const clipped = buttons.filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left < headerRect.left - 1 || rect.right > headerRect.right + 1 ||
            rect.top < headerRect.top - 1 || rect.bottom > headerRect.bottom + 1;
        });
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          headerHeight: Math.round(headerRect.height),
          headerWidth: Math.round(headerRect.width),
          terminal: {
            width: Math.round(terminal.getBoundingClientRect().width),
            height: Math.round(terminal.getBoundingClientRect().height)
          },
          buttonCount: buttons.length,
          clippedButtons: clipped.map((button) => button.getAttribute('data-testid'))
        };
      })()`)
    }

    const normal = await measure(1180, 760)
    assert(normal, 'The session header was not measurable at 1180x760')
    assert(
      normal.headerHeight <= 52,
      `The session header is not compact (${normal.headerHeight}px)`
    )
    assert(
      normal.clippedButtons.length === 0,
      `Header controls overflow at 1180x760: ${JSON.stringify(normal.clippedButtons)}`
    )
    assert(
      normal.terminal.height >= 560,
      `The terminal is still short at 1180x760 (${normal.terminal.height}px)`
    )
    await screenshot('04c-compact-header')

    const narrow = await measure(760, 480)
    assert(narrow, 'The session header was not measurable at 760x480')
    assert(
      narrow.headerHeight <= 52,
      `The session header grew at the minimum width (${narrow.headerHeight}px)`
    )
    assert(
      narrow.clippedButtons.length === 0,
      `Header controls overflow at 760x480: ${JSON.stringify(narrow.clippedButtons)}`
    )

    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(500)
    return { normal, narrow }
  })

  const secondTitle = 'Smoke shell two'
  let secondSession = null

  await step('create a second session and keep both PTYs alive while switching', async () => {
    await click('[data-testid="sidebar-new-menu"]')
    await waitForSelector('[data-testid="new-session-open"]', 10000)
    await click('[data-testid="new-session-open"]')
    await waitForSelector('[data-testid="new-session-repo"]')
    await click('[data-testid="harness-option-shell"]')
    await setInput('[data-testid="session-title-input"]', secondTitle)
    await click('[data-testid="create-session-submit"]')
    await waitFor(
      `new Set(Array.from(document.querySelectorAll('[data-session-id]')).map((el) => el.dataset.sessionId)).size === 2`,
      'two sessions',
      20000
    )
    await waitFor(
      `document.querySelector('[data-testid="session-title"]')?.innerText === ${JSON.stringify(secondTitle)}`,
      'second session selected'
    )
    secondSession = await sessionByTitle(secondTitle)
    assert(secondSession && secondSession.id !== firstSession.id, 'Second session was not created')
    await waitForTerminalLine(
      secondSession.id,
      (line) => /\$\s*$/.test(line),
      'the second shell prompt before typing'
    )
    await typeInSession(
      secondSession.id,
      'export ICODE_SMOKE=second; echo SECOND_PID=$$; echo SECOND_READY'
    )
    await waitForTerminalLine(
      secondSession.id,
      (line) => line.trim() === 'SECOND_READY',
      'the second command completion'
    )

    await click(`[data-testid="session-item-${firstSession.id}"]`)
    await sleep(400)
    await typeInSession(
      firstSession.id,
      'echo FIRST_STILL=$ICODE_SMOKE; echo FIRST_PID_NOW=$$; echo STILL_ALIVE'
    )
    await waitForTerminalLine(
      firstSession.id,
      (line) => line.trim() === 'FIRST_STILL=first',
      'the first PTY environment marker'
    )
    const pidRows = await waitForTerminalLine(
      firstSession.id,
      (line) => /^FIRST_PID_NOW=\d+$/.test(line.trim()),
      'the first PTY pid after switching'
    )
    const pidNow = /^FIRST_PID_NOW=(\d+)$/m.exec(pidRows.join('\n'))
    assert(pidNow, 'Could not read the first PTY pid after switching')
    assert(
      firstPid !== null && Number(pidNow[1]) === firstPid,
      'First PTY was replaced instead of kept alive'
    )
    await waitForTerminalLine(
      firstSession.id,
      (line) => line.trim() === 'STILL_ALIVE',
      'the first terminal command after switching'
    )

    const allPanes = await panes()
    assert(allPanes.length === 2, 'Both terminal panes should stay mounted')
    assert(
      allPanes.filter((pane) => pane.active === 'true').length === 1,
      'Exactly one terminal pane should be active'
    )
    const inactive = allPanes.find((pane) => pane.active === 'false')
    assert(inactive && inactive.phase === 'live', 'Inactive PTY is no longer live')
    await screenshot('06-two-sessions-first-reattached')

    await rightClick(`[data-testid="session-tab-${firstSession.id}"]`)
    await waitForSelector('[data-testid="session-tab-menu"]', 10000)
    const tabMenuText = await cdp.evaluate(
      `document.querySelector('[data-testid="session-tab-menu"]').innerText`
    )
    assert(
      tabMenuText.includes('Close other tabs') && tabMenuText.includes('Split right'),
      `Session tab menu is incomplete: ${tabMenuText}`
    )
    await cdp.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )
    await waitFor(
      `!document.querySelector('[data-testid="session-tab-menu"]')`,
      'session tab menu to close',
      5000
    )

    await click('[data-testid="session-split-toggle"]')
    await waitForSelector('[data-testid="session-split-divider"]', 10000)
    assert(
      await cdp.evaluate(
        `document.querySelectorAll('[data-testid="session-header"]').length === 2`
      ),
      'Split view did not show both sessions'
    )
    await screenshot('06b-session-split')
    await click('[data-testid="session-split-toggle"]')
    await waitFor(
      `!document.querySelector('[data-testid="session-split-divider"]')`,
      'split view to close',
      5000
    )
    return { firstPid: Number(pidNow[1]), activePanes: allPanes }
  })

  await step('reorder session tabs when a drag is dispatched in one task', async () => {
    /*
     * A native drag runs its own event loop, so React state written in
     * dragstart is not guaranteed to be committed before dragover/drop.
     * Dispatch the whole sequence in one task: the reorder must not depend on
     * a React render landing between the events.
     */
    const before = await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="session-tabs"] [role="tab"]')).map((el) => el.getAttribute('data-session-id'))`
    )
    assert(before.length === 2, `Expected two session tabs, saw ${before.length}`)
    const prevented = await cdp.evaluate(`(() => {
      const tabs = Array.from(document.querySelectorAll('[data-testid="session-tabs"] [role="tab"]'));
      const source = tabs[0];
      const target = tabs[1];
      const data = new DataTransfer();
      const fire = (element, type) =>
        element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      fire(source, 'dragstart');
      fire(target, 'dragenter');
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data });
      target.dispatchEvent(over);
      const overPrevented = over.defaultPrevented;
      fire(target, 'drop');
      fire(source, 'dragend');
      return overPrevented;
    })()`)
    assert(prevented, 'The tab strip did not accept dragover for a tab drag')
    const expected = [before[1], before[0]]
    await waitFor(
      `(() => {
        const ids = Array.from(document.querySelectorAll('[data-testid="session-tabs"] [role="tab"]')).map((el) => el.getAttribute('data-session-id'));
        return JSON.stringify(ids) === ${JSON.stringify(JSON.stringify(expected))} ? ids : null;
      })()`,
      'session tab drag reorder',
      5000
    )
    await screenshot('06c-session-tabs-reordered')
    return { before, after: expected }
  })

  await step('reorder worktrees with a sidebar drag', async () => {
    /*
     * The drag is dispatched in one task, so the reorder cannot depend on a
     * React render landing between dragstart and drop. The order is persisted
     * through the sidebarOrder IPC; restore it so later steps keep their
     * natural worktree order.
     */
    const groupsExpression = `(() => {
      const root = document.querySelector('[data-testid="sidebar-sessions-${repoId}"]');
      if (!root) return null;
      return Array.from(root.querySelectorAll('[data-testid^="sidebar-worktree-"]'))
        .filter((el) => /^sidebar-worktree-(?!toggle-|new-session-)/.test(el.getAttribute('data-testid')))
        .map((el) => el.getAttribute('data-testid'));
    })()`
    await waitFor(`(${groupsExpression} || []).length >= 2`, 'two sidebar worktrees', 10000)
    const before = await cdp.evaluate(groupsExpression)
    assert(before.length >= 2, `Expected two worktrees in the sidebar, saw ${before.length}`)

    const dragFirstOntoSecond = async () => {
      const accepted = await cdp.evaluate(`(() => {
        const root = document.querySelector('[data-testid="sidebar-sessions-${repoId}"]');
        const groups = Array.from(root.querySelectorAll('[data-testid^="sidebar-worktree-"]'))
          .filter((el) => /^sidebar-worktree-(?!toggle-|new-session-)/.test(el.getAttribute('data-testid')));
        const source = groups[0].querySelector('[data-testid^="sidebar-worktree-toggle-"]');
        const target = groups[1].querySelector('[data-testid^="sidebar-worktree-toggle-"]');
        const data = new DataTransfer();
        const rect = target.getBoundingClientRect();
        const point = { clientX: rect.left + rect.width / 2, clientY: rect.bottom - 2 };
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
        const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, ...point });
        target.dispatchEvent(over);
        const overAccepted = over.defaultPrevented;
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, ...point }));
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }));
        return overAccepted;
      })()`)
      assert(accepted, 'The worktree row did not accept dragover')
    }

    await dragFirstOntoSecond()
    const expected = [before[1], before[0], ...before.slice(2)]
    await waitFor(
      `JSON.stringify(${groupsExpression}) === ${JSON.stringify(JSON.stringify(expected))}`,
      'sidebar worktree reorder',
      5000
    )
    await screenshot('06d-sidebar-worktrees-reordered')

    await dragFirstOntoSecond()
    await waitFor(
      `JSON.stringify(${groupsExpression}) === ${JSON.stringify(JSON.stringify(before))}`,
      'sidebar worktree order restored',
      5000
    )
    return { before, after: expected }
  })

  await step('exit a live shell and keep its session record', async () => {
    await click(`[data-testid="session-item-${firstSession.id}"]`)
    await typeInSession(firstSession.id, 'exit')
    await waitForState('exited', 15000)
    const final = await activeState()
    assert(final.reason === 'host_exited', `Unexpected exit reason ${final.reason}`)
    await screenshot('08-session-exited')
    return { final }
  })

  let restartedIncarnation = null

  await step('restart a session and bind the terminal to the new incarnation', async () => {
    const before = await sessionByTitle(firstTitle)
    assert(before, 'First session disappeared before restart')
    await sessionAction('restart-session')
    const immediate = await activeState()
    assert(immediate && immediate.text.includes('Restarting'), 'Restart did not show a pending state')
    await waitForState('live', 20000)
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid^="terminal-pane-"]')).some((pane) => pane.getAttribute('data-phase') === 'live' && pane.getAttribute('data-active') === 'true')`,
      'restarted terminal pane',
      20000
    )
    const after = await sessionByTitle(firstTitle)
    assert(after && after.incarnation, 'Restarted session has no incarnation')
    assert(
      after.incarnation !== before.incarnation,
      'Restart reused the previous incarnation'
    )
    restartedIncarnation = after.incarnation
    await waitForTerminalLine(
      after.id,
      (line) => /\$\s*$/.test(line),
      'the restarted shell prompt'
    )
    await typeInSession(after.id, 'echo RESTART_READY')
    await waitForTerminalLine(
      after.id,
      (line) => line.trim() === 'RESTART_READY',
      'the restarted terminal output'
    )
    await screenshot('09-session-restarted')
    return { before: before.incarnation, after: after.incarnation }
  })

  await step('relaunch iCode and reattach to the surviving incarnations', async () => {
    const meta = hostMeta()
    assert(meta && pidAlive(meta.pid), 'Detached terminal host is not running before relaunch')
    const beforeQuit = await sessions()
    const firstBefore = beforeQuit.find((entry) => entry.id === firstSession.id)
    const secondBefore = beforeQuit.find((entry) => entry.id === secondSession.id)
    assert(firstBefore && secondBefore, 'Sessions missing before relaunch')
    const hostPid = meta.pid

    await quitApp()
    await sleep(1000)
    assert(pidAlive(hostPid), 'Terminal host died with the iCode app')
    if (!IS_WINDOWS) {
      assert(existsSync(SOCKET), 'Terminal host socket disappeared with the iCode app')
    }

    port = nextPort++
    await launch('relaunch', hostEnv(), port)
    await openProjectSessions()
    await waitFor(
      `new Set(Array.from(document.querySelectorAll('[data-session-id]')).map((el) => el.dataset.sessionId)).size === 2`,
      'sessions restored from persistence',
      20000
    )
    const afterQuit = await sessions()
    const firstAfter = afterQuit.find((entry) => entry.id === firstSession.id)
    assert(firstAfter, 'First session was lost across relaunch')
    assert(
      firstAfter.incarnation === firstBefore.incarnation,
      'Relaunch created a different PTY incarnation'
    )
    assert(firstAfter.state === 'live', 'Relaunched session is not live')
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid^="terminal-pane-"]')).some((pane) => pane.getAttribute('data-phase') === 'live')`,
      'reattached terminal pane',
      20000
    )
    await click(`[data-testid="session-item-${firstSession.id}"]`)
    await sleep(400)
    await typeInSession(firstSession.id, 'echo RELAUNCH_OK')
    await waitForTerminalLine(
      firstSession.id,
      (line) => line.trim() === 'RELAUNCH_OK',
      'the reattached terminal output'
    )
    await screenshot('11-relaunch-reattached')
    return {
      hostPid,
      incarnationBefore: firstBefore.incarnation,
      incarnationAfter: firstAfter.incarnation,
      sessions: afterQuit.length
    }
  })

  await step('present an unreachable Host truthfully', async () => {
    await quitApp()
    port = nextPort++
    await launch(
      'unreachable-host',
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
    await openProjectSessions()
    await waitFor(
      `new Set(Array.from(document.querySelectorAll('[data-session-id]')).map((el) => el.dataset.sessionId)).size >= 1`,
      'sessions restored while the Host is unreachable',
      20000
    )
    const firstVisible = (await sessions())[0]
    assert(firstVisible, 'No session row while the Host is unreachable')
    await click(`[data-testid="session-item-${firstVisible.id}"]`)
    await sleep(400)
    const state = await activeState()
    assert(
      state && (state.reason === 'host_unreachable' || state.reason === 'host_unreachable_history'),
      `Unreachable Host not reflected in session state: ${JSON.stringify(state)}`
    )
    assert((await panes()).length === 0, 'A terminal was mounted without a reachable Host')
    const text = await bodyText()
    assert(text.toLowerCase().includes('unreachable'), 'No unreachable Host explanation in the UI')

    await screenshot('12-host-unreachable')
    await openProjectSessions()

    // New session is prohibited while the Host is unreachable. Queue task
    // remains available because it does not need a live PTY to be created.
    await click('[data-testid="sidebar-new-menu"]')
    await waitForSelector('[data-testid="new-session-open"]', 10000)
    const createDisabled = await cdp.evaluate(`(() => {
      const button = document.querySelector('[data-testid="new-session-open"]')
      return button ? { disabled: button.getAttribute('aria-disabled') === 'true', title: button.title } : null
    })()`)
    assert(createDisabled && createDisabled.disabled, 'New session stayed enabled while the Host was unreachable')
    assert(
      String(createDisabled.title).toLowerCase().includes('host'),
      `New session did not explain the Host refusal: ${JSON.stringify(createDisabled)}`
    )
    const queueVisible = await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="queue-task-open"]'))`
    )
    assert(queueVisible, 'Queue task disappeared with the Host outage')
    await screenshot('13-session-creation-disabled')
    return { state, createDisabled }
  })

  await step('restore Host and stop the surviving sessions', async () => {
    await quitApp()
    port = nextPort++
    await launch('restored', hostEnv(), port)
    await waitFor(
      `document.querySelector('[data-testid="host-status"]')?.dataset.hostStatus === 'reachable'`,
      'reachable Host status',
      30000
    )
    await openProjectSessions()
    await waitFor(
      `new Set(Array.from(document.querySelectorAll('[data-session-id]')).map((el) => el.dataset.sessionId)).size === 2`,
      'sessions back after the Host became reachable',
      20000
    )
    const restored = await sessions()
    assert(restored.length === 2, 'Sessions did not return after the Host became reachable')
    for (const session of restored) {
      await click(`[data-testid="session-item-${session.id}"]`)
      await sleep(300)
      const current = await activeState()
      if (current && (current.state === 'live' || current.state === 'starting')) {
        await typeInSession(session.id, 'exit')
        await waitForState('exited', 15000)
      }
    }
    const stopped = await sessions()
    assert(
      stopped.every((entry) => entry.state !== 'live' && entry.state !== 'starting'),
      `Sessions are still live: ${JSON.stringify(stopped)}`
    )
    return { stopped }
  })

  await step('show a truthful no-available-Harness state', async () => {
    await quitApp()
    port = nextPort++
    await launch(
      'no-harnesses',
      {
        ...hostEnv(),
        // Hide agent executables and the user shell from Harness detection.
        PATH: EMPTY_BIN,
        SHELL: join(EMPTY_BIN, 'no-shell')
      },
      port
    )
    await openProjectSessions()
    await waitFor(
      `document.querySelector('[data-testid="harness-summary"]')?.innerText.includes('0/46')`,
      'no available Harnesses',
      30000
    )
    await click('[data-testid="sidebar-new-menu"]')
    await waitForSelector('[data-testid="new-session-open"]', 10000)
    await click('[data-testid="new-session-open"]')
    // Nothing is launchable, so every detection sits behind the disclosure.
    await waitForSelector('[data-testid="harness-more"]', 20000)
    await click('[data-testid="harness-more"]')
    await waitFor(
      `document.querySelectorAll('[data-harness-state]').length === 46`,
      'all unavailable detections',
      20000
    )
    const detections = await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-harness-state]')).map((element) => ({
        harness: element.getAttribute('data-testid').replace('harness-option-', ''),
        state: element.getAttribute('data-harness-state'),
        disabled: element.disabled
      }))`
    )
    assert(
      detections.every((entry) => entry.state === 'unavailable' && entry.disabled),
      `Expected all Harnesses unavailable: ${JSON.stringify(detections)}`
    )
    const dialogText = await cdp.evaluate(
      `document.querySelector('[role="dialog"]').innerText`
    )
    assert(
      dialogText.includes('0 of 46 Harnesses available'),
      'No-available-Harness guidance is missing'
    )
    const createDisabled = await cdp.evaluate(
      `document.querySelector('[data-testid="create-session-submit"]').disabled`
    )
    assert(createDisabled, 'Session creation is enabled without an available Harness')
    await screenshot('14-no-available-harness')
    await quitApp()
    return { detections }
  })

  await step('remove a repository after confirming', async () => {
    port = nextPort++
    await launch('final', { ICODE_HOST_DIR: HOST_DIR, ICODE_HOST_SOCKET: SOCKET }, port)
    await waitFor(
      `document.querySelector('[data-testid="host-status"]')?.dataset.hostStatus === 'reachable'`,
      'reachable Host status',
      30000
    )
    await waitForSelector('[data-testid^="project-row-"]', 20000)
    await rightClick(`[data-testid="project-row-${repoId}"]`)
    await waitForSelector('[data-testid="sidebar-project-menu"]', 10000)
    const rightClickMenuText = await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-project-menu"]').innerText`
    )
    assert(
      rightClickMenuText.includes('Remove repository'),
      'Right-click menu is missing Remove repository'
    )
    assert(rightClickMenuText.includes('Copy path'), 'Right-click menu is missing Copy path')
    assert(
      await cdp.evaluate(`Boolean(document.querySelector('[data-testid="sessions-surface"]'))`),
      'Right-click opened the project instead of its menu'
    )
    await cdp.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )
    await waitFor(
      `!document.querySelector('[data-testid="sidebar-project-menu"]')`,
      'right-click menu to close',
      5000
    )
    await waitFor(
      `document.activeElement?.getAttribute('data-testid') === 'project-row-${repoId}'`,
      'focus to return to the project row',
      5000
    )

    const worktreeParent = join(USER_DATA, 'worktrees', repoId)
    const sessionDir = existsSync(worktreeParent)
      ? readdirSync(worktreeParent, { withFileTypes: true }).find(
          (entry) => entry.isDirectory() && entry.name.startsWith('ses_')
        )
      : null
    const dirtyWorktree = sessionDir ? join(worktreeParent, sessionDir.name) : null
    if (dirtyWorktree && existsSync(dirtyWorktree)) {
      writeFileSync(join(dirtyWorktree, 'SMOKE_DIRTY.txt'), 'uncommitted\n')
    }

    await removeRepositoryFromSidebar(repoId)
    // The confirmation closes before removal starts, then the row disappears
    // optimistically.
    await waitFor(
      `!document.querySelector('[data-testid="project-row-${repoId}"]')`,
      'repository removed from All projects',
      20000
    )
    assert(
      await cdp.evaluate(
        `!document.querySelector('[data-testid="remove-repository-dialog"]')`
      ),
      'Removal dialog stayed open after confirming'
    )
    await waitForSelector('[data-testid="empty-workspace"]', 20000)
    assert(
      (await bodyText()).includes('Add a project'),
      'Empty workspace copy is missing after removal'
    )
    assert((await sessions()).length === 0, 'Session records survived repository removal')
    if (dirtyWorktree && existsSync(dirtyWorktree)) {
      const refs = await waitForRemovalRef()
      assert(refs.includes('refs/icode/removed/'), 'Dirty work was not snapshotted')
      await waitForPathGone(dirtyWorktree)
    }
    await screenshot('16-repository-removed')
    return { removed: true }
  })

  await quitApp()
  const meta = hostMeta()
  RUN.host = meta ? { pid: meta.pid, aliveAfterQuit: pidAlive(meta.pid) } : null
  if (meta && pidAlive(meta.pid)) {
    try {
      process.kill(meta.pid, 'SIGTERM')
    } catch {
      // Best-effort cleanup of the smoke host.
    }
  }
  RUN.finishedAt = new Date().toISOString()
  RUN.status = 'passed'
}

async function run() {
  try {
    await main()
  } catch (error) {
    RUN.status = 'failed'
    RUN.finishedAt = new Date().toISOString()
    RUN.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
    await screenshot('failure')
    log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
    try {
      await quitApp()
    } catch {
      // Ignore teardown failures.
    }
    process.exitCode = 1
  } finally {
    const resultPath = join(ARTIFACT_DIR, 'ui-smoke.json')
    writeFileSync(resultPath, `${JSON.stringify(RUN, null, 2)}\n`)
    log(`evidence: ${resultPath}`)
    log(`run directory: ${RUN_DIR}`)
    log(`status: ${RUN.status}`)
  }
}

void run()
