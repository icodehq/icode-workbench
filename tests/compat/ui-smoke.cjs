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
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const ELECTRON = require('electron')
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

async function openProjectSessions() {
  if (
    await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="project-sessions-list"]'))`
    )
  ) {
    return
  }
  if (
    !(await cdp.evaluate(`Boolean(document.querySelector('[data-testid="projects-wall"]'))`))
  ) {
    await click('[data-testid="rail-projects"]')
    await waitForSelector('[data-testid="projects-wall"]', 20000)
  }
  await waitForSelector('[data-testid^="project-row-"]', 20000)
  if (repoId === null) {
    repoId = await cdp.evaluate(
      `document.querySelector('[data-testid^="project-row-"]')?.getAttribute('data-testid')?.replace('project-row-', '') ?? null`
    )
  }
  assert(repoId, 'Could not identify the registered repository lane')
  await click(`[data-testid="open-project-${repoId}"]`)
  await waitForSelector('[data-testid="project-header"]', 20000)
  await click('[data-testid="project-mode-sessions"]')
  await waitForSelector('[data-testid="project-sessions-list"]', 20000)
}

async function openRepositories() {
  if (
    await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="repositories-view"]'))`
    )
  ) {
    return
  }
  if (
    !(await cdp.evaluate(`Boolean(document.querySelector('[data-testid="projects-wall"]'))`))
  ) {
    await click('[data-testid="rail-projects"]')
    await waitForSelector('[data-testid="projects-wall"]', 20000)
  }
  await click('[data-testid="manage-repositories"]')
  await waitForSelector('[data-testid="repositories-view"]', 20000)
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
    `Timed out waiting for ${description} in the terminal (last rows: ${JSON.stringify(last.slice(0, 14))})`
  )
}

function requireElectron() {
  assert(typeof ELECTRON === 'string' && existsSync(ELECTRON), 'Electron binary not found')
}

function prepareRunDir() {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  mkdirSync(REPO_DIR, { recursive: true })
  mkdirSync(USER_DATA, { recursive: true })
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
    await launch('initial', { ICODE_HOST_DIR: HOST_DIR, ICODE_HOST_SOCKET: SOCKET }, port)
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
    await waitForSelector('[data-testid="project-search"]')
    await waitForSelector('[data-testid^="project-filter-"]')
    await screenshot('02a-project-directory')

    await setInput('[data-testid="project-search"]', 'no-such-project')
    await waitForSelector('[data-testid="project-directory-empty"]', 5000)
    await setInput('[data-testid="project-search"]', '')
    await waitForSelector('[data-testid^="project-row-"]', 5000)

    await click(`[data-testid="pin-project-${repoId}"]`)
    await waitFor(
      `document.querySelector('[data-testid="pin-project-${repoId}"]')?.getAttribute('aria-pressed') === 'true'`,
      'project pin',
      5000
    )
    await click('[data-testid="project-filter-pinned"]')
    await waitFor(
      `document.querySelectorAll('[data-testid^="project-row-"]').length === 1`,
      'pinned directory filter',
      5000
    )
    await click('[data-testid="project-filter-all"]')

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
    assert(text.includes('No direct sessions yet'), 'Repository workspace did not load')
    await screenshot('02-repository-registered')
    return { notice: await notice() }
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
      const topbar = document.querySelector('[data-testid="app-topbar"]');
      const controls = [...document.querySelectorAll('button[data-testid^="window-"]')];
      const clipped = controls.filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1;
      });
      return {
        viewport: { width: innerWidth, height: innerHeight },
        topbarHeight: Math.round(topbar.getBoundingClientRect().height),
        controls: controls.length,
        clipped: clipped.map((button) => button.getAttribute('data-testid')),
        drag: getComputedStyle(topbar).getPropertyValue('-webkit-app-region').trim(),
        closeDrag: getComputedStyle(document.querySelector('[data-testid="window-close"]')).getPropertyValue('-webkit-app-region').trim()
      };
    })()`)
    assert(info.controls === 3, `Expected three window controls, got ${String(info.controls)}`)
    assert(info.clipped.length === 0, `Window controls overflow at 760x480: ${JSON.stringify(info)}`)
    assert(info.drag === 'drag', `Top bar is not a drag region: ${JSON.stringify(info)}`)
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
    await waitFor(
      `document.querySelectorAll('[data-harness-state]').length === 4`,
      'four Harness detections',
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
    const normal = await terminalRect()
    assert(normal, 'Terminal pane was not measurable')

    await click('[data-testid="sessions-list-collapse"]')
    await waitFor(
      `!document.querySelector('[data-testid="project-sessions-list"]')`,
      'the sessions list to collapse',
      10_000
    )
    const withoutList = await terminalRect()
    assert(
      withoutList && withoutList.width > normal.width + 250,
      `Collapsing Sessions did not widen the terminal (${normal?.width} -> ${withoutList?.width})`
    )

    await pressF11()
    await waitFor(
      `!document.querySelector('[data-testid="global-search"]') &&
       !document.querySelector('[data-testid="app-rail"]') &&
       !document.querySelector('[data-testid="project-header"]') &&
       !document.querySelector('[data-testid="statusbar"]')`,
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
       Boolean(document.querySelector('[data-testid="app-rail"]'))`,
      'F11 to leave focus mode',
      10_000
    )
    // Clear any partial line a function key may have left in the shell.
    await typeInSession(firstSession.id, '\u0003')

    // Restore the list for the remaining multi-session steps.
    await click('[data-testid="show-sessions-list"]')
    await waitForSelector('[data-testid="project-sessions-list"]', 10_000)
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
    return { firstPid: Number(pidNow[1]), activePanes: allPanes }
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

  await step('block repository removal while a PTY is live', async () => {
    await openRepositories()
    await click(`[data-testid="repository-remove-${repoId}"]`)
    await waitForNotice('live sessions', 20000)
    const feedback = await notice()
    assert(feedback.tone === 'error', 'Blocked removal was not reported as an error')
    const repoStillRegistered = await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="repository-row-${repoId}"]'))`
    )
    assert(repoStillRegistered, 'Repository disappeared after a blocked removal')
    await openProjectSessions()
    const afterBlocked = await sessions()
    assert(
      afterBlocked.length === 2,
      `Sessions were deleted by a blocked removal (count=${afterBlocked.length}, body=${(await bodyText()).slice(0, 240)})`
    )
    await screenshot('10-removal-blocked')
    return feedback
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
    assert(existsSync(SOCKET), 'Terminal host socket disappeared with the iCode app')

    port = nextPort++
    await launch('relaunch', { ICODE_HOST_DIR: HOST_DIR, ICODE_HOST_SOCKET: SOCKET }, port)
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

  await step('present an unreachable Host truthfully and refuse unverified removal', async () => {
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

    await openRepositories()
    await click(`[data-testid="repository-remove-${repoId}"]`)
    await waitForNotice('Could not verify live sessions', 30000)
    const feedback = await notice()
    const repoStillRegistered = await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="repository-row-${repoId}"]'))`
    )
    assert(repoStillRegistered, 'Repository was removed without host verification')
    await screenshot('12-host-unreachable')
    await openProjectSessions()

    // New session is prohibited while the Host is unreachable. Queue task
    // remains available because it does not need a live PTY to be created.
    const createDisabled = await cdp.evaluate(`(() => {
      const button = document.querySelector('[data-testid="new-session-open"]')
      return button ? { disabled: button.disabled, title: button.title } : null
    })()`)
    assert(createDisabled && createDisabled.disabled, 'New session stayed enabled while the Host was unreachable')
    assert(
      String(createDisabled.title).toLowerCase().includes('host'),
      `New session did not explain the Host refusal: ${JSON.stringify(createDisabled)}`
    )
    const queueVisible = await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="queue-task-from-menu"]')) || Boolean(document.querySelector('[data-testid="new-menu"]'))`
    )
    assert(queueVisible, 'Queue task disappeared with the Host outage')
    await screenshot('13-session-creation-disabled')
    return { state, feedback, createDisabled }
  })

  await step('restore Host and stop the surviving sessions', async () => {
    await quitApp()
    port = nextPort++
    await launch('restored', { ICODE_HOST_DIR: HOST_DIR, ICODE_HOST_SOCKET: SOCKET }, port)
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
        ICODE_HOST_DIR: HOST_DIR,
        ICODE_HOST_SOCKET: SOCKET,
        // Hide agent executables and the user shell from Harness detection.
        PATH: EMPTY_BIN,
        SHELL: join(EMPTY_BIN, 'no-shell')
      },
      port
    )
    await openProjectSessions()
    await waitFor(
      `document.querySelector('[data-testid="harness-summary"]')?.innerText.includes('0/4')`,
      'no available Harnesses',
      30000
    )
    await click('[data-testid="new-session-open"]')
    await waitFor(
      `document.querySelectorAll('[data-harness-state]').length === 4`,
      'four unavailable detections',
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
      dialogText.includes('0 of 4 Harnesses available'),
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

  await step('complete acknowledged repository removal', async () => {
    port = nextPort++
    await launch('final', { ICODE_HOST_DIR: HOST_DIR, ICODE_HOST_SOCKET: SOCKET }, port)
    await waitFor(
      `document.querySelector('[data-testid="host-status"]')?.dataset.hostStatus === 'reachable'`,
      'reachable Host status',
      30000
    )
    await openRepositories()
    await click(`[data-testid="repository-remove-${repoId}"]`)
    await waitForSelector('[data-testid="confirm-remove-repo"]', 20000)
    const dialogText = await cdp.evaluate(
      `document.querySelector('[role="dialog"]').innerText`
    )
    assert(dialogText.includes('Remove'), 'Removal confirmation is missing')
    assert(dialogText.includes(firstTitle), 'Confirmation does not list dependent sessions')
    await screenshot('15-removal-confirmation')
    await click('[data-testid="confirm-remove-repo"]')
    await waitFor(
      `!document.querySelector('[data-testid="repository-row-${repoId}"]')`,
      'repository removed from the Repositories page',
      20000
    )
    await click('[data-testid="rail-projects"]')
    await waitForSelector('[data-testid="empty-workspace"]', 20000)
    assert(
      (await bodyText()).includes('Add a project'),
      'Empty workspace copy is missing after removal'
    )
    const finalNotice = await notice()
    assert(finalNotice && finalNotice.tone === 'success', 'Removal success was not confirmed')
    assert((await sessions()).length === 0, 'Session records survived repository removal')
    await screenshot('16-repository-removed')
    return { finalNotice }
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
