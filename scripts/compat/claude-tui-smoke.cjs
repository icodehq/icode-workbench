'use strict'
/**
 * Work 7 — real Claude Code interactive TUI acceptance.
 *
 * Drives the product UI over CDP and the real Claude Code executable through:
 * renderer/xterm -> preload -> main IPC -> host protocol -> PTY -> Claude TUI.
 *
 * ADE data and the Host runtime live in an isolated temp directory. Claude Code
 * keeps its own user config (authentication is user-owned and is never read,
 * copied, or logged here). Artifacts contain UI text and screenshots only; no
 * environment dumps, tokens, or credential files.
 */
const { spawn, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const ELECTRON = require('electron')

// Work 7 runs the development Electron binary. Work 9 runs the packaged Linux
// application with a default (isolated) user-data path.
const PACKAGED = process.env.ADE_SMOKE_TARGET === 'packaged'
const PACKAGED_EXE = process.env.ADE_SMOKE_EXECUTABLE ?? join(APP_DIR, 'dist', 'linux-unpacked', 'ade')
const PACKAGED_RESOURCES = join(resolve(PACKAGED_EXE, '..'), 'resources')
const ARTIFACT_DIR = process.env.ADE_SMOKE_ARTIFACTS
  ? resolve(process.env.ADE_SMOKE_ARTIFACTS)
  : join(APP_DIR, 'artifacts', PACKAGED ? 'work9' : 'work7')
const RUN_DIR = mkdtempSync(join(tmpdir(), PACKAGED ? 'ade-work9-claude-' : 'ade-work7-claude-'))
const REPO_DIR = join(RUN_DIR, 'repo')
const USER_DATA = join(RUN_DIR, 'userdata')
const XDG_CONFIG_HOME = join(RUN_DIR, 'xdg-config')
// Electron derives userData from XDG_CONFIG_HOME plus the app name.
const PACKAGED_USER_DATA = join(XDG_CONFIG_HOME, 'ade')
const PACKAGED_RUNTIME_DIR = join(RUN_DIR, 'xdg-runtime')
const HOST_DIR = join(RUN_DIR, 'host')
const SOCKET = join(HOST_DIR, 'terminal-host.sock')
let activeHostDir = HOST_DIR

const CRITERIA = PACKAGED
  ? {
      repo: 'AC3',
      harness: 'AC4',
      start: 'AC4',
      prompt: 'AC4',
      redraw: 'AC4',
      resize: 'AC4',
      switch: 'AC4',
      relaunch: 'AC5',
      stop: 'AC6',
      cleanup: 'AC6'
    }
  : {
      repo: 'AC1',
      harness: 'AC1',
      start: 'AC1',
      prompt: 'AC2',
      redraw: 'AC3',
      resize: 'AC4',
      switch: 'AC5',
      relaunch: 'AC6',
      stop: 'AC7',
      cleanup: 'AC7'
    }

const TOKENS = {
  alpha: 'WORK7_TUI_ALPHA_91c2',
  beta: 'WORK7_TUI_BETA_4f17',
  gamma: 'WORK7_TUI_GAMMA_2b6d',
  delta: 'WORK7_TUI_DELTA_73ae'
}

const RUN = {
  work: PACKAGED ? 9 : 7,
  target: PACKAGED ? 'packaged-linux-x64' : 'development-electron',
  startedAt: new Date().toISOString(),
  runDir: RUN_DIR,
  steps: [],
  criteria: {},
  failures: [],
  artifacts: [],
  limitations: []
}

let appProcess = null
let cdp = null
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

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function log(message) {
  process.stdout.write(`[claude-tui] ${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function writeEvidence() {
  const resultPath = join(ARTIFACT_DIR, 'claude-tui.json')
  RUN.artifactPath = resultPath
  writeFileSync(resultPath, `${JSON.stringify(RUN, null, 2)}\n`)
  return resultPath
}

async function step(name, criterion, work) {
  const startedAt = Date.now()
  log(`${name}`)
  try {
    const details = await work()
    RUN.steps.push({
      name,
      criterion,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      ...(details === undefined ? {} : { details })
    })
    if (criterion && !RUN.criteria[criterion]) RUN.criteria[criterion] = 'PASS'
    writeEvidence()
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
    RUN.failures.push(`${name}: ${message}`)
    if (criterion) RUN.criteria[criterion] = 'FAIL'
    writeEvidence()
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
    RUN.artifacts.push(`${path} (failed: ${error instanceof Error ? error.message : String(error)})`)
  }
}

function cleanLine(text) {
  return text.replace(/\s+$/u, '')
}

function screenExcerpt(lines, limit = 40) {
  const meaningful = lines.map(cleanLine).filter((line) => line.trim().length > 0)
  return meaningful.slice(-limit)
}

async function waitFor(expression, description, timeoutMs = 20000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression)
      if (last) return last
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${description} (last: ${JSON.stringify(last)})`)
}

async function waitForSelector(selector, timeoutMs = 20000) {
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

async function sessions() {
  return cdp.evaluate(`Array.from(document.querySelectorAll('[data-session-id]')).map((element) => ({
    id: element.dataset.sessionId,
    state: element.dataset.sessionState,
    incarnation: element.dataset.sessionIncarnation,
    text: element.innerText
  }))`)
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
    active: element.getAttribute('data-active'),
    phase: element.getAttribute('data-phase')
  }))`)
}

async function rows(sessionId) {
  return cdp.evaluate(`(() => {
    const pane = document.querySelector('[data-testid="terminal-pane-${sessionId}"]');
    if (!pane) return [];
    return Array.from(pane.querySelectorAll('.xterm-rows > div')).map((row) => row.textContent || '');
  })()`)
}

async function cursorPosition(sessionId) {
  return cdp.evaluate(`(() => {
    const pane = document.querySelector('[data-testid="terminal-pane-${sessionId}"]');
    const cursor = pane && pane.querySelector('.xterm-cursor');
    const screen = pane && pane.querySelector('.xterm-screen');
    if (!cursor || !screen) return null;
    const c = cursor.getBoundingClientRect();
    const s = screen.getBoundingClientRect();
    return {
      x: Math.round(c.left - s.left),
      y: Math.round(c.top - s.top),
      withinScreen: c.left >= s.left - 1 && c.right <= s.right + 1 && c.top >= s.top - 1 && c.bottom <= s.bottom + 1
    };
  })()`)
}

async function attachInfo(sessionId) {
  return cdp.evaluate(`window.ade.terminal.attach({ sessionId: ${JSON.stringify(sessionId)} }).then((result) => {
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      seq: result.value.seq,
      cols: result.value.cols,
      rows: result.value.rows,
      alternateScreen: result.value.alternateScreen,
      truncated: result.value.truncated,
      snapshotBytes: result.value.snapshot.length,
      cursor: result.value.cursor
    };
  })`)
}

async function focusTerminal(sessionId) {
  const focused = await cdp.evaluate(`(() => {
    const pane = document.querySelector('[data-testid="terminal-pane-${sessionId}"]');
    const textarea = pane && pane.querySelector('.xterm-helper-textarea');
    if (!textarea) return false;
    textarea.focus();
    return document.activeElement === textarea;
  })()`)
  assert(focused, `Terminal ${sessionId} could not take focus`)
}

async function pressKey(name, code, virtualKeyCode, text) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: name,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    ...(text ? { text } : {})
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: name,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  })
}

async function pressEnter() {
  await pressKey('Enter', 'Enter', 13, '\r')
}

async function typeText(sessionId, text) {
  await focusTerminal(sessionId)
  await cdp.send('Input.insertText', { text })
  await sleep(250)
}

function hasInputPrompt(lines) {
  // The empty prompt shows a grey placeholder such as `❯ Try "refactor <file>"`,
  // so the marker — not the absence of text — identifies the input box.
  return lines.some((line) => /^\s*❯/.test(line))
}

function isIdle(lines) {
  const joined = lines.join('\n')
  if (/esc to interrupt/i.test(joined)) return false
  if (/\b(Thinking|Pontificating|Onioning|Brewed|Cooking|Simmering|Clauding|Noodling)\b[^\n]*…/i.test(joined)) {
    return false
  }
  return hasInputPrompt(lines)
}

async function waitForIdle(sessionId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await rows(sessionId)
    if (isIdle(last)) return last
    await sleep(250)
  }
  throw new Error(`Claude TUI did not become idle (last: ${JSON.stringify(screenExcerpt(last, 18))})`)
}

async function waitForScreen(sessionId, predicate, description, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await rows(sessionId)
    if (predicate(last)) return last
    await sleep(150)
  }
  throw new Error(
    `Timed out waiting for ${description} (last: ${JSON.stringify(screenExcerpt(last, 22))})`
  )
}

function countOccurrences(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length
}

function responseLine(lines, token) {
  return lines.find((line) => new RegExp(`^●\\s*${token}\\s*$`).test(line.trim()))
}

async function submitPrompt(sessionId, text, token, description, busyScreenshot) {
  await waitForIdle(sessionId)
  await typeText(sessionId, text)
  const echoed = await waitForScreen(
    sessionId,
    (lines) => lines.some((line) => line.includes(token)),
    `typed prompt for ${description}`,
    15000
  )
  await pressEnter()

  let busySeen = false
  let busyCaptured = false
  const deadline = Date.now() + 180000
  let response = null
  while (Date.now() < deadline) {
    const lines = await rows(sessionId)
    if (/esc to interrupt/i.test(lines.join('\n'))) {
      busySeen = true
      if (!busyCaptured && busyScreenshot) {
        busyCaptured = true
        await screenshot(busyScreenshot)
      }
    }
    if (responseLine(lines, token)) {
      response = lines
      break
    }
    await sleep(200)
  }
  assert(response, `No Claude response containing ${token} for ${description}`)
  const idle = await waitForIdle(sessionId, 180000)
  assert(responseLine(idle, token), `Response for ${description} disappeared after the TUI went idle`)

  const promptEchoes = idle.filter((line) => /^\s*❯\s/.test(line) && line.includes(token))
  assert(promptEchoes.length === 1, `Expected exactly one prompt echo for ${description}, saw ${String(promptEchoes.length)}`)
  const tokenRows = countOccurrences(idle, token)
  assert(tokenRows === 2, `Expected the token in exactly two rows (prompt + response), saw ${String(tokenRows)}`)

  return { echoed: screenExcerpt(echoed, 8), busySeen, screen: screenExcerpt(idle, 24), tokenRows }
}

async function waitForTui(sessionId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await rows(sessionId)
    const joined = last.join('\n')
    if (joined.includes('Quick safety check') || joined.includes('Yes, I trust this folder')) {
      return { trustDialog: true, lines: last }
    }
    if (joined.includes('Claude Code v') && hasInputPrompt(last)) {
      return { trustDialog: false, lines: last }
    }
    await sleep(250)
  }
  throw new Error(`Claude Code TUI did not start (last: ${JSON.stringify(screenExcerpt(last, 22))})`)
}

async function acceptTrustDialog(sessionId) {
  await sleep(700)
  await cdp.send('Page.bringToFront').catch(() => {})
  // Default selection is "No, exit"; the second option trusts the test repo.
  // The TUI can ignore the first key while it finishes initializing, so retry
  // until the selection visibly moves.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await focusTerminal(sessionId)
    await pressKey('ArrowDown', 'ArrowDown', 40)
    await sleep(350)
    const lines = await rows(sessionId)
    if (lines.some((line) => /❯\s+Yes, I trust this folder/.test(line))) {
      const selected = lines
      await pressEnter()
      await waitForScreen(
        sessionId,
        (screen) => screen.join('\n').includes('Claude Code v'),
        'Claude welcome screen',
        60000
      )
      return screenExcerpt(selected, 20)
    }
    if (!lines.join('\n').includes('Yes, I trust this folder')) {
      // The dialog closed without an explicit selection change.
      await waitForScreen(
        sessionId,
        (screen) => screen.join('\n').includes('Claude Code v'),
        'Claude welcome screen',
        60000
      )
      return screenExcerpt(lines, 20)
    }
  }
  throw new Error('Claude trust dialog did not accept the selection')
}

function stripAnsi(input) {
  return input
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[()][A-Z0-9]/g, '')
}

function wslgWindows() {
  const output = execFileSync(
    process.execPath,
    [join(__dirname, 'wslg-window-probe.cjs'), '--json', '--match', 'ADE'],
    { encoding: 'utf8' }
  )
  return JSON.parse(output)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function hostLogEvents() {
  const path = join(activeHostDir, 'host.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function redactionCheck(text) {
  const patterns = [
    /sk-ant-[A-Za-z0-9_-]{8,}/,
    /ANTHROPIC_API_KEY\s*=/,
    /CLAUDE_CODE_OAUTH_TOKEN\s*=/,
    /Bearer\s+[A-Za-z0-9._-]{16,}/
  ]
  return patterns.some((pattern) => pattern.test(text))
}

function prepareRunDir() {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  mkdirSync(REPO_DIR, { recursive: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: REPO_DIR })
  writeFileSync(join(REPO_DIR, 'README.md'), '# ADE Work 7 Claude TUI acceptance\n')
  execFileSync('git', ['add', 'README.md'], { cwd: REPO_DIR })
  execFileSync(
    'git',
    ['-c', 'user.email=ade@example.test', '-c', 'user.name=ADE', 'commit', '-qm', 'init'],
    { cwd: REPO_DIR }
  )
}

function discoverPackagedHostDir() {
  if (!existsSync(XDG_CONFIG_HOME)) return null
  for (const entry of readdirSync(XDG_CONFIG_HOME, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(XDG_CONFIG_HOME, entry.name, 'run')
    if (existsSync(join(candidate, 'meta.json'))) return candidate
  }
  return null
}

function hostMeta() {
  const path = join(activeHostDir, 'meta.json')
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

async function launch(label, environment) {
  if (PACKAGED) {
    assert(existsSync(PACKAGED_EXE), `Packaged executable is missing: ${PACKAGED_EXE}`)
    mkdirSync(XDG_CONFIG_HOME, { recursive: true })
    mkdirSync(PACKAGED_RUNTIME_DIR, { recursive: true, mode: 0o700 })
  }
  const logPath = join(ARTIFACT_DIR, `app-${label}.log`)
  const logStream = createWriteStream(logPath)
  RUN.artifacts.push(logPath)
  const port = await allocatePort()
  const args = PACKAGED
    ? [`--remote-debugging-port=${port}`]
    : ['.', `--remote-debugging-port=${port}`]
  const baseEnv = PACKAGED
    ? {
        ...process.env,
        // Isolation without ADE_GATE_* overrides: the packaged app uses its
        // normal default userData/host paths under these XDG directories.
        XDG_CONFIG_HOME,
        XDG_RUNTIME_DIR: PACKAGED_RUNTIME_DIR,
        DISPLAY: process.env.DISPLAY ?? ':0'
      }
    : { ...process.env, ADE_GATE_USER_DATA: USER_DATA }
  appProcess = spawn(PACKAGED ? PACKAGED_EXE : ELECTRON, args, {
    cwd: APP_DIR,
    env: {
      ...baseEnv,
      ADE_BACKGROUND_LAUNCH: '0',
      ...environment
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  appProcess.stdout.pipe(logStream)
  appProcess.stderr.pipe(logStream)
  appProcess.on('exit', (code, signal) => log(`app ${label} exited code=${code} signal=${signal}`))
  cdp = await connect(port)
  cdp.port = port
  if (PACKAGED) {
    const discovered = discoverPackagedHostDir()
    if (discovered) activeHostDir = discovered
    RUN.packaged = {
      executable: PACKAGED_EXE,
      resources: PACKAGED_RESOURCES,
      userData: discovered ? resolve(discovered, '..') : PACKAGED_USER_DATA,
      hostDir: activeHostDir,
      xdgConfigHome: XDG_CONFIG_HOME,
      xdgRuntimeDir: PACKAGED_RUNTIME_DIR,
      gateEnvOverrides: Object.keys(process.env).filter((key) => key.startsWith('ADE_GATE_'))
    }
  }
  await waitForSelector('[data-testid="repo-select"]', 30000)
  await waitFor(
    `!document.body.innerText.includes('Loading repositories')`,
    'workspace boot',
    30000
  )
  return port
}

async function quitApp() {
  if (!cdp) return
  try {
    await Promise.race([
      cdp.evaluate('window.close()'),
      // Why: the page can close before the CDP reply arrives.
      sleep(2500)
    ])
  } catch {
    // The page can disappear before the reply is delivered.
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

async function createSessionFromUi(title, harness) {
  await click('[data-testid="new-session-open"]')
  await waitForSelector(`[data-testid="harness-option-${harness}"]`, 20000)
  await click(`[data-testid="harness-option-${harness}"]`)
  await setInput('[data-testid="session-title-input"]', title)
  await click('[data-testid="create-session-submit"]')
  await waitFor(
    `document.querySelector('[data-testid="session-title"]')?.innerText === ${JSON.stringify(title)}`,
    `session ${title} selected`,
    30000
  )
  await waitFor(
    `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === 'live'`,
    `session ${title} live`,
    30000
  )
  const list = await sessions()
  const session = list.find((entry) => entry.text.split('\n')[0] === title)
  assert(session, `Session ${title} is missing from the sidebar`)
  assert(session.incarnation, `Session ${title} has no incarnation`)
  return session
}

async function main() {
  prepareRunDir()
  writeEvidence()
  RUN.environment = {
    repo: REPO_DIR,
    userData: PACKAGED ? PACKAGED_USER_DATA : USER_DATA,
    hostDir: PACKAGED ? join(PACKAGED_USER_DATA, 'run') : HOST_DIR,
    socket: PACKAGED ? join(PACKAGED_RUNTIME_DIR, 'ade', 'terminal-host.sock') : SOCKET,
    electron: PACKAGED ? PACKAGED_EXE : ELECTRON,
    node: process.version,
    platform: process.platform,
    display: process.env.DISPLAY ?? null,
    claudeConfig: 'user-owned (not copied, not logged)'
  }
  if (PACKAGED) {
    const version = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version
    RUN.build = {
      source: APP_DIR,
      executable: PACKAGED_EXE,
      executableSha256: sha256File(PACKAGED_EXE),
      appAsarSha256: sha256File(join(PACKAGED_RESOURCES, 'app.asar')),
      version
    }
  }

  let claude = null
  let shell = null
  let baselineRows = null

  await step('register a real local Git repository from the UI', CRITERIA.repo, async () => {
    await launch(
      'initial',
      PACKAGED ? {} : { ADE_HOST_DIR: HOST_DIR, ADE_HOST_SOCKET: SOCKET }
    )
    const text = await bodyText()
    assert(text.includes('Add your first repository'), 'First-run empty state is missing')
    if (PACKAGED) {
      // The packaged app must use its normal default userData path, not a
      // test override, and the profile must be the isolated one.
      const dataDir = join(PACKAGED_USER_DATA)
      assert(existsSync(dataDir), `Default packaged userData is missing: ${dataDir}`)
      assert(existsSync(join(dataDir, 'ade.sqlite')), 'Packaged SQLite database was not created')
      const gateKeys = Object.keys(process.env).filter((key) => key.startsWith('ADE_GATE_'))
      assert(gateKeys.length === 0, `ADE_GATE_* must not be set: ${gateKeys.join(', ')}`)
      RUN.firstRun = {
        emptyState: true,
        userDataDir: dataDir,
        sqlite: 'ade.sqlite',
        gateOverrides: gateKeys
      }
      await screenshot('00-first-run')
    }
    await click('[data-testid="empty-add-repo"]')
    await waitForSelector('[data-testid="add-repo-input"]')
    await setInput('[data-testid="add-repo-input"]', REPO_DIR)
    await click('[data-testid="add-repo-submit"]')
    await waitFor(
      `document.querySelector('[data-testid="notice"]')?.innerText.includes('Registered')`,
      'repository registration',
      30000
    )
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="repo-select"] option')).some((option) => option.textContent.includes('repo'))`,
      'registered repository'
    )
    await screenshot('01-repository-registered')
    return { repo: REPO_DIR }
  })

  if (PACKAGED) {
    await step('verify a visible ADE window on the WSLg display', 'AC2', async () => {
      const probe = wslgWindows()
      const mapped = probe.mappedMatches.filter(
        (window) => window.width > 0 && window.height > 0
      )
      assert(mapped.length >= 1, `No mapped ADE window on ${probe.display}`)
      const window = mapped[0]
      await screenshot('02-wslg-window')
      return {
        display: probe.display,
        screen: probe.screen,
        windowCount: probe.windowCount,
        mappedWindow: {
          id: window.id,
          name: window.name,
          className: window.className,
          width: window.width,
          height: window.height
        },
        user: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(),
        uid: execFileSync('id', ['-u'], { encoding: 'utf8' }).trim()
      }
    })
  }

  await step('detect the real Claude Code Harness', CRITERIA.harness, async () => {
    await click('[data-testid="empty-new-session"]')
    await waitFor(
      `document.querySelectorAll('[data-harness-state]').length === 4`,
      'Harness detections',
      30000
    )
    const states = await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-harness-state]')).map((element) => ({
        harness: element.getAttribute('data-testid').replace('harness-option-', ''),
        state: element.getAttribute('data-harness-state'),
        disabled: element.disabled,
        text: element.innerText
      }))`
    )
    const claudeState = states.find((entry) => entry.harness === 'claude')
    assert(claudeState && claudeState.state === 'available', 'Claude Code is not available')
    assert(
      /Available\s*·\s*2\.1\.\d+/.test(claudeState.text),
      `Claude version was not detected: ${claudeState.text}`
    )
    await screenshot('02-harness-detection')
    return { states }
  })

  await step('start a real Claude Code TUI session and render its interface', CRITERIA.start, async () => {
    await click('[data-testid="harness-option-claude"]')
    await setInput('[data-testid="session-title-input"]', 'Claude TUI acceptance')
    await click('[data-testid="create-session-submit"]')
    await waitFor(
      `document.querySelector('[data-testid="session-title"]')?.innerText === 'Claude TUI acceptance'`,
      'Claude session selected',
      30000
    )
    await waitFor(
      `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === 'live'`,
      'Claude session live',
      30000
    )
    const list = await sessions()
    claude = list.find((entry) => entry.text.startsWith('Claude TUI acceptance'))
    assert(claude && claude.incarnation, 'Claude session has no incarnation')

    const tui = await waitForTui(claude.id, 60000)
    let trust = null
    if (tui.trustDialog) {
      trust = await acceptTrustDialog(claude.id)
      await waitForTui(claude.id, 60000)
    }
    const info = await attachInfo(claude.id)
    assert(info.ok && info.alternateScreen, 'Claude TUI is not using the alternate screen')

    const ready = await waitForIdle(claude.id, 60000)
    const joined = ready.join('\n')
    assert(joined.includes('Claude Code v'), 'Claude Code welcome header is missing')
    assert(hasInputPrompt(ready), 'Claude input prompt is missing')
    assert(!redactionCheck(joined), 'Credential-like text appeared in the terminal')
    baselineRows = ready

    if (PACKAGED) {
      // Prove the TUI is the real Claude executable inside the Host-owned PTY:
      // the PTY pid must be a direct child of the packaged Host process.
      const meta = hostMeta()
      assert(meta, 'Packaged Host metadata is missing')
      const spawn = hostLogEvents().find(
        (event) => event.event === 'pty-spawn' && event.sessionId === claude.id
      )
      assert(spawn, 'No pty-spawn entry for the Claude session')
      assert(pidAlive(spawn.ptyPid), 'Claude PTY process is not running')
      const stat = readFileSync(`/proc/${String(spawn.ptyPid)}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      const argv = readFileSync(`/proc/${String(spawn.ptyPid)}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean)
      const hostArgv = readFileSync(`/proc/${String(meta.pid)}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean)
      assert(ppid === meta.pid, `Claude pid ${String(spawn.ptyPid)} is not a child of the Host`)
      assert(
        argv.some((argument) => /(^|\/)claude$/.test(argument)),
        `PTY command is not Claude: ${JSON.stringify(argv)}`
      )
      assert(
        hostArgv.some((argument) => argument.endsWith('app.asar.unpacked/out/host/index.js')),
        `Host is not the packaged Host entry: ${JSON.stringify(hostArgv)}`
      )
      RUN.claudeProcess = {
        ptyPid: spawn.ptyPid,
        parentPid: ppid,
        hostPid: meta.pid,
        argv,
        hostArgv,
        incarnationId: spawn.incarnationId
      }
    }

    await screenshot('03-claude-tui-ready')
    return {
      session: claude,
      trustDialog: trust,
      alternateScreen: info.alternateScreen,
      dimensions: { cols: info.cols, rows: info.rows },
      snapshotSeq: info.seq,
      screen: screenExcerpt(ready, 12)
    }
  })

  await step('send a harmless prompt and observe a real model response', CRITERIA.prompt, async () => {
    const result = await submitPrompt(
      claude.id,
      `Reply with exactly this token and nothing else: ${TOKENS.alpha}. Do not use any tools.`,
      TOKENS.alpha,
      'alpha prompt',
      '04-claude-thinking'
    )
    const state = await activeState()
    assert(state.state === 'live', 'Session is not live after the response')
    await screenshot('05-claude-response')
    return {
      responseTime: 'observed',
      busySeen: result.busySeen,
      promptEchoCount: 1,
      tokenRows: result.tokenRows,
      screen: result.screen
    }
  })

  await step('verify redraw consistency after the response', CRITERIA.redraw, async () => {
    const after = await rows(claude.id)
    const info = await attachInfo(claude.id)
    const tokenRows = countOccurrences(after, TOKENS.alpha)
    assert(tokenRows === 2, `Token appears in ${String(tokenRows)} rows after redraw`)
    assert(responseLine(after, TOKENS.alpha), 'Response line is missing from the final screen')
    assert(hasInputPrompt(after), 'Input prompt disappeared after the response')
    assert(after.filter((line) => /^\s*❯\s/.test(line) && line.includes(TOKENS.alpha)).length === 1, 'Prompt echo was duplicated')
    assert(!after.some((line) => line.includes('\uFFFD')), 'Replacement characters indicate broken redraw')
    assert(!after.join('\n').includes('\u001b'), 'Raw escape sequences leaked into rendered rows')
    const maxRowLength = Math.max(...after.map((line) => line.length))
    assert(maxRowLength <= info.cols, `Rendered row width ${String(maxRowLength)} exceeds ${String(info.cols)} columns`)
    const cursor = await cursorPosition(claude.id)
    assert(cursor && cursor.withinScreen, 'Terminal cursor is outside the terminal screen')
    const snapshot = await cdp.evaluate(`window.ade.terminal.attach({ sessionId: ${JSON.stringify(claude.id)} }).then((result) => result.ok ? {
      seq: result.value.seq,
      alternateScreen: result.value.alternateScreen,
      bytes: result.value.snapshot.length,
      text: result.value.snapshot
    } : { ok: false })`)
    assert(snapshot && snapshot.text, 'Could not read the Host terminal snapshot')
    const snapshotText = stripAnsi(snapshot.text)
    const snapshotTokenRows = snapshotText.split(/\r?\n/).filter((line) => line.includes(TOKENS.alpha)).length
    assert(snapshotTokenRows === 2, `Host snapshot has ${String(snapshotTokenRows)} token rows, expected 2`)
    // Cursor-forward codes collapse the banner's spacing, so compare compacted text.
    const compactSnapshot = snapshotText.replace(/\s+/g, '')
    assert(
      compactSnapshot.includes('ClaudeCodev2.1.306'),
      'Host snapshot lost the Claude TUI header'
    )
    assert(!redactionCheck(snapshotText), 'Credential-like text appeared in the Host snapshot')
    await screenshot('06-claude-redraw-consistent')
    return {
      tokenRows,
      promptEchoCount: 1,
      maxRowLength,
      cols: info.cols,
      rows: info.rows,
      snapshotSeq: info.seq,
      snapshotAfter: { seq: snapshot.seq, alternateScreen: snapshot.alternateScreen, bytes: snapshot.bytes, tokenRows: snapshotTokenRows },
      cursor,
      screen: screenExcerpt(after, 20)
    }
  })

  await step('resize the terminal and confirm the real Claude TUI adapts', CRITERIA.resize, async () => {
    const before = await attachInfo(claude.id)
    assert(before.ok, 'Could not read dimensions before resize')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 980,
      height: 620,
      deviceScaleFactor: 1,
      mobile: false
    })
    await waitFor(
      `window.ade.terminal.attach({ sessionId: ${JSON.stringify(claude.id)} }).then((r) => r.ok && r.value.cols < ${String(before.cols)})`,
      'PTY width to shrink',
      15000,
      250
    )
    await sleep(800)
    const after = await attachInfo(claude.id)
    assert(after.ok, 'Could not read dimensions after resize')
    assert(after.cols < before.cols && after.rows < before.rows, 'PTY did not adopt the smaller size')

    const resized = await waitForIdle(claude.id, 60000)
    const joined = resized.join('\n')
    assert(joined.includes('Claude Code v'), 'TUI header was lost after resize')
    assert(countOccurrences(resized, TOKENS.alpha) === 2, 'Conversation was duplicated or lost after resize')
    assert(hasInputPrompt(resized), 'Input prompt is missing after resize')
    const cursor = await cursorPosition(claude.id)
    assert(cursor && cursor.withinScreen, 'Cursor left the screen after resize')
    await screenshot('07-claude-resized')

    const beta = await submitPrompt(
      claude.id,
      `Reply with exactly this token and nothing else: ${TOKENS.beta}. Do not use any tools.`,
      TOKENS.beta,
      'beta prompt after resize'
    )
    const restoredBefore = await attachInfo(claude.id)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await waitFor(
      `window.ade.terminal.attach({ sessionId: ${JSON.stringify(claude.id)} }).then((r) => r.ok && r.value.cols === ${String(before.cols)})`,
      'PTY width to return',
      15000,
      250
    )
    const restored = await attachInfo(claude.id)
    const finalRows = await waitForIdle(claude.id, 60000)
    assert(hasInputPrompt(finalRows), 'TUI is not interactive after restoring the size')
    assert(countOccurrences(finalRows, TOKENS.beta) === 2, 'Resized response was corrupted after restoring size')
    await screenshot('08-claude-resize-restored')
    return {
      before: { cols: before.cols, rows: before.rows },
      after: { cols: after.cols, rows: after.rows },
      restored: { cols: restored.cols, rows: restored.rows },
      resizedSubmit: { busySeen: beta.busySeen, tokenRows: beta.tokenRows, cols: restoredBefore.cols },
      screen: screenExcerpt(finalRows, 18)
    }
  })

  await step('keep the Claude PTY alive while switching to a second session', CRITERIA.switch, async () => {
    shell = await createSessionFromUi('Work 7 shell control', 'shell')
    await waitForScreen(shell.id, (lines) => lines.some((line) => /\$\s*$/.test(line)), 'shell prompt')
    await typeText(shell.id, 'export WORK7_SHELL=kept; echo SHELL_PID=$$')
    await pressEnter()
    const shellRows = await waitForScreen(
      shell.id,
      (lines) => lines.some((line) => /^SHELL_PID=\d+$/.test(line.trim())),
      'shell pid'
    )
    const shellPid = /^SHELL_PID=(\d+)$/m.exec(shellRows.join('\n'))[1]

    await click(`[data-testid="session-item-${claude.id}"]`)
    await sleep(500)
    const gamma = await submitPrompt(
      claude.id,
      `Reply with exactly this token and nothing else: ${TOKENS.gamma}. Do not use any tools.`,
      TOKENS.gamma,
      'gamma prompt after switching'
    )
    const afterGamma = await sessions()
    const claudeAfter = afterGamma.find((entry) => entry.id === claude.id)
    assert(claudeAfter.incarnation === claude.incarnation, 'Claude incarnation changed while switching')
    const allPanes = await panes()
    assert(allPanes.length === 2, 'Both terminal panes should remain mounted')
    assert(allPanes.filter((pane) => pane.active === 'true').length === 1, 'Exactly one pane should be active')

    await click(`[data-testid="session-item-${shell.id}"]`)
    await sleep(400)
    await typeText(shell.id, 'echo SHELL_STILL=$WORK7_SHELL; echo SHELL_PID_NOW=$$')
    await pressEnter()
    const shellAfter = await waitForScreen(
      shell.id,
      (lines) => lines.some((line) => /^SHELL_PID_NOW=\d+$/.test(line.trim())),
      'shell pid after switching'
    )
    const pidNow = /^SHELL_PID_NOW=(\d+)$/m.exec(shellAfter.join('\n'))[1]
    assert(pidNow === shellPid, 'Shell PTY was replaced while switching')
    assert(shellAfter.join('\n').includes('SHELL_STILL=kept'), 'Shell environment was lost while switching')
    const claudePane = (await panes()).find((pane) => pane.id.includes(claude.id))
    assert(claudePane && claudePane.phase === 'live' && claudePane.active === 'false', 'Inactive Claude pane is not preserved')
    await screenshot('09-two-sessions-claude-preserved')
    return {
      claudeIncarnation: claudeAfter.incarnation,
      shellPid,
      gammaScreen: gamma.screen
    }
  })

  await step('relaunch ADE and reattach to the same Claude TUI incarnation', CRITERIA.relaunch, async () => {
    const meta = hostMeta()
    assert(meta && pidAlive(meta.pid), 'Detached Host is not alive before relaunch')
    hostPid = meta.pid
    const claudeBefore = (await sessions()).find((entry) => entry.id === claude.id)
    assert(claudeBefore && claudeBefore.state === 'live', 'Claude session is not live before relaunch')
    const alphaRows = await rows(claude.id)
    const alphaCount = countOccurrences(alphaRows, TOKENS.alpha)

    await quitApp()
    await sleep(1000)
    assert(pidAlive(hostPid), 'Detached Host died when ADE quit')
    const metaNow = hostMeta()
    assert(metaNow && existsSync(metaNow.socket), 'Host socket disappeared when ADE quit')

    await launch(
      'relaunch',
      PACKAGED ? {} : { ADE_HOST_DIR: HOST_DIR, ADE_HOST_SOCKET: SOCKET }
    )
    await waitFor(
      `Array.from(document.querySelectorAll('[data-session-id]')).length === 2`,
      'persisted sessions',
      30000
    )
    await click(`[data-testid="session-item-${claude.id}"]`)
    await waitFor(
      `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === 'live'`,
      'Claude session live after relaunch',
      30000
    )
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid^="terminal-pane-"]')).some((pane) => pane.getAttribute('data-active') === 'true' && pane.getAttribute('data-phase') === 'live')`,
      'Claude terminal pane after relaunch',
      30000
    )
    const after = await sessions()
    const claudeAfter = after.find((entry) => entry.id === claude.id)
    assert(claudeAfter.incarnation === claudeBefore.incarnation, 'Relaunch created a new Claude incarnation')
    const hostEvents = hostLogEvents()
    const spawns = hostEvents.filter(
      (event) => event.event === 'pty-spawn' && event.sessionId === claude.id
    )
    assert(spawns.length === 1, `Expected one Claude PTY spawn, saw ${String(spawns.length)}`)
    const connects = hostEvents.filter((event) => event.event === 'client-connected').length
    assert(connects >= 2, `Expected a relaunch connection, saw ${String(connects)}`)
    RUN.hostLifecycle = {
      hostPid,
      claudeSpawns: spawns.length,
      clientConnections: connects,
      incarnationBefore: claudeBefore.incarnation,
      incarnationAfter: claudeAfter.incarnation
    }
    const restored = await waitForIdle(claude.id, 60000)
    assert(restored.join('\n').includes('Claude Code v'), 'Claude TUI did not return after relaunch')
    assert(
      countOccurrences(restored, TOKENS.alpha) === alphaCount,
      'Previous conversation was not restored from the surviving PTY'
    )
    const info = await attachInfo(claude.id)
    assert(info.ok && info.alternateScreen, 'Reattached Claude TUI is not in the alternate screen')
    await screenshot('10-claude-reattached')

    const delta = await submitPrompt(
      claude.id,
      `Reply with exactly this token and nothing else: ${TOKENS.delta}. Do not use any tools.`,
      TOKENS.delta,
      'delta prompt after reattachment'
    )
    const finalRows = await rows(claude.id)
    assert(responseLine(finalRows, TOKENS.delta), 'Reattached TUI did not accept new input')
    await screenshot('11-claude-reattached-response')
    return {
      hostPid,
      incarnationBefore: claudeBefore.incarnation,
      incarnationAfter: claudeAfter.incarnation,
      tokensBefore: alphaCount,
      tokensAfter: countOccurrences(restored, TOKENS.alpha),
      alternateScreen: info.alternateScreen,
      deltaScreen: delta.screen,
      screen: screenExcerpt(finalRows, 18)
    }
  })

  await step('stop the Claude session and confirm the Host-owned final state', CRITERIA.stop, async () => {
    await click('[data-testid="stop-session"]')
    const immediate = await activeState()
    assert(immediate.text.includes('Stopping') || immediate.state === 'exited', 'Stop did not show pending state')
    await waitFor(
      `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === 'exited'`,
      'Claude session exited',
      20000
    )
    const final = await activeState()
    assert(final.reason === 'host_exited', `Unexpected Claude exit reason: ${final.reason}`)
    await screenshot('12-claude-stopped')
    return { immediate, final }
  })

  await step('stop the control session and clean up the isolated Host', CRITERIA.cleanup, async () => {
    await click(`[data-testid="session-item-${shell.id}"]`)
    await sleep(400)
    const shellState = await activeState()
    if (shellState.state === 'live' || shellState.state === 'starting') {
      await click('[data-testid="stop-session"]')
      await waitFor(
        `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === 'exited'`,
        'control session exited',
        20000
      )
    }
    const all = await sessions()
    assert(all.every((entry) => entry.state === 'exited'), `Sessions remain live: ${JSON.stringify(all)}`)

    await quitApp()
    assert(hostPid && pidAlive(hostPid), 'Detached Host did not survive the final app quit')
    try {
      process.kill(hostPid, 'SIGTERM')
    } catch {
      // Already gone.
    }
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && pidAlive(hostPid)) await sleep(200)
    assert(!pidAlive(hostPid), 'Test Host is still running after cleanup')

    const repoStatus = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_DIR })
      .toString()
      .trim()
    assert(repoStatus === '', `Test repository was modified: ${repoStatus}`)

    const lingering = []
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        if (readlinkSync(`/proc/${entry}/cwd`) === REPO_DIR) {
          lingering.push({ pid: Number(entry), command: readFileSync(`/proc/${entry}/comm`, 'utf8').trim() })
        }
      } catch {
        // Process vanished or is not inspectable.
      }
    }
    assert(lingering.length === 0, `Test processes still running: ${JSON.stringify(lingering)}`)
    const hostLogSource = join(activeHostDir, 'host.log')
    let hostLogArtifact = null
    if (existsSync(hostLogSource)) {
      hostLogArtifact = join(ARTIFACT_DIR, 'host.log')
      copyFileSync(hostLogSource, hostLogArtifact)
      RUN.artifacts.push(hostLogArtifact)
    }
    return {
      hostPid,
      hostStopped: true,
      repoTouched: false,
      lingeringProcesses: lingering,
      hostLog: hostLogArtifact
    }
  })

  RUN.finishedAt = new Date().toISOString()
  RUN.status = 'passed'
}

function cleanupHost() {
  const meta = hostMeta()
  const pid = meta ? meta.pid : hostPid
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
}

async function cleanup() {
  try {
    await quitApp()
  } catch {
    // Ignore app teardown failures.
  }
  cleanupHost()
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
    await cleanup()
    process.exitCode = 1
  } finally {
    const resultPath = writeEvidence()
    log(`evidence: ${resultPath}`)
    log(`run directory: ${RUN_DIR}`)
    log(`status: ${RUN.status}`)
  }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    log(`received ${signal}; cleaning up`)
    RUN.status = 'interrupted'
    RUN.finishedAt = new Date().toISOString()
    try {
      cleanupHost()
      writeEvidence()
    } finally {
      process.exit(1)
    }
  })
}

process.on('exit', () => {
  if (RUN.status !== 'passed' || !existsSync(join(ARTIFACT_DIR, 'claude-tui.json'))) {
    try {
      writeEvidence()
    } catch {
      // Best effort at process teardown.
    }
  }
})

void run()
