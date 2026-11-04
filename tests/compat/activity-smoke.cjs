'use strict'
/**
 * Work 14 acceptance: Claude agent activity and attention through the real UI.
 *
 * Runs the packaged Linux application with an isolated XDG profile and an
 * isolated CLAUDE_CONFIG_DIR. It drives three independent sources of evidence:
 *
 * 1. the shipped Hook script, invoked from a real PTY, for deterministic
 *    working/waiting/ordering transitions;
 * 2. the real `claude` CLI with iCode's additive `--settings` overlay, for the
 *    actual Hook dispatch path, while a user canary hook keeps running;
 * 3. the packaged UI, which must show activity separately from lifecycle state.
 *
 * The user's own ~/.claude/settings.json is hashed before and after and must be
 * byte-identical. OS notifications cannot be observed under WSLg/CDP, so that
 * scenario is recorded as NOT RUN rather than claimed.
 */
const { execFileSync, spawn } = require('node:child_process')
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const PACKAGED_EXE = process.env.ICODE_SMOKE_EXECUTABLE ?? join(APP_DIR, 'dist', 'linux-unpacked', 'icode')
const ARTIFACT_DIR = process.env.ICODE_SMOKE_ARTIFACTS ?? join(APP_DIR, 'artifacts', 'work14')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'icode-work14-accept-'))
const REPO_DIR = join(RUN_DIR, 'repo')
const XDG_CONFIG = join(RUN_DIR, 'xdg-config')
const XDG_RUNTIME = join(RUN_DIR, 'xdg-runtime')
const USER_DATA = join(XDG_CONFIG, 'iCode')
const HOST_DIR = join(USER_DATA, 'run')
const CLAUDE_CONFIG = join(RUN_DIR, 'claude-config')
const CANARY = join(RUN_DIR, 'canary.log')
const REAL_CLAUDE_SETTINGS = join(process.env.HOME ?? '', '.claude', 'settings.json')

const RUN = {
  work: 14,
  startedAt: new Date().toISOString(),
  runDir: RUN_DIR,
  steps: [],
  failures: [],
  artifacts: [],
  criteria: {},
  notRun: {
    notifications:
      'OS notifications are not observable under WSLg/CDP; unit tests cover suppression, dedupe and click-to-focus.',
    unreadWhileUnfocused:
      'CDP drives a focused window here; unfocused unread and notification suppression are covered by unit tests.',
    realClaudeSuccessfulStop:
      'The isolated CLI is unauthenticated, so the real turn ends with StopFailure; a completed turn is covered by the shipped Hook probe and unit tests.',
    exitPlanMode:
      'ExitPlanMode needs an authenticated model and an interactive plan approval; only domain mapping is unit-tested.',
    relaunchReset:
      'Activity is in-memory by construction; no packaged relaunch was performed in this smoke.'
  }
}
let cdp = null
let appProcess = null
let hostPid = null

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (message) => process.stdout.write(`[activity] ${message}\n`)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(path) {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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
  writeFileSync(join(ARTIFACT_DIR, 'activity-smoke.json'), `${JSON.stringify(RUN, null, 2)}\n`)
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

function notice() {
  return cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="notice"]');
    return el ? { tone: el.dataset.tone, text: el.innerText } : null;
  })()`)
}

function sessions() {
  return cdp.evaluate(`Array.from(document.querySelectorAll('[data-session-id]')).map((el) => ({
    id: el.dataset.sessionId,
    state: el.dataset.sessionState,
    activity: el.dataset.sessionActivity,
    unread: el.dataset.sessionActivityUnread,
    text: el.innerText
  }))`)
}

/** Header chip plus the selected session's sidebar row and unread marker. */
function activityUi() {
  return cdp.evaluate(`(() => {
    const header = document.querySelector('[data-testid="session-activity"]');
    const selected = document.querySelector('[data-session-id][aria-current="true"]')
      ?? document.querySelector('[data-session-id]');
    const id = selected?.dataset?.sessionId ?? null;
    const row = id ? document.querySelector('[data-testid="session-item-' + id + '"]') : null;
    const marker = id ? document.querySelector('[data-testid="session-activity-' + id + '"]') : null;
    return {
      sessionId: id,
      focused: document.hasFocus(),
      header: header ? {
        state: header.getAttribute('data-activity'),
        tool: header.getAttribute('data-activity-tool'),
        unread: header.getAttribute('data-activity-unread'),
        text: header.innerText
      } : null,
      sidebar: row ? {
        state: row.dataset.sessionActivity,
        unread: row.dataset.sessionActivityUnread,
        text: row.innerText
      } : null,
      marker: marker ? { text: marker.innerText, state: marker.dataset.activity } : null
    };
  })()`)
}

async function waitForActivity(state, description, timeoutMs = 20000) {
  await waitFor(
    `document.querySelector('[data-testid="session-activity"]')?.getAttribute('data-activity') === ${JSON.stringify(state)}`,
    description,
    timeoutMs
  )
  return activityUi()
}

function rows(sessionId) {
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
  await sleep(400)
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

async function launch() {
  mkdirSync(XDG_CONFIG, { recursive: true })
  mkdirSync(XDG_RUNTIME, { recursive: true, mode: 0o700 })
  mkdirSync(CLAUDE_CONFIG, { recursive: true })
  const logPath = join(ARTIFACT_DIR, 'app.log')
  const stream = createWriteStream(logPath)
  RUN.artifacts.push(logPath)
  const port = await allocatePort()
  appProcess = spawn(PACKAGED_EXE, [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: XDG_CONFIG,
      XDG_RUNTIME_DIR: XDG_RUNTIME,
      CLAUDE_CONFIG_DIR: CLAUDE_CONFIG,
      DISPLAY: process.env.DISPLAY ?? ':0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  appProcess.stdout.pipe(stream)
  appProcess.stderr.pipe(stream)
  appProcess.on('exit', (code, signal) => log(`app exited code=${code} signal=${signal}`))
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

async function createShellSession(title) {
  const opening = await cdp.evaluate(
    `Boolean(document.querySelector('[data-testid="empty-new-session"]'))`
  )
  await click(opening ? '[data-testid="empty-new-session"]' : '[data-testid="new-session-open"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="harness-option-shell"]'))`, 'new session dialog')
  await click('[data-testid="harness-option-shell"]')
  await setInput('[data-testid="session-title-input"]', title)
  await click('[data-testid="create-session-submit"]')
  await waitFor(
    `document.querySelector('[data-testid="session-title"]')?.innerText === ${JSON.stringify(title)}`,
    `session ${title} to open`,
    30000
  )
  const list = await sessions()
  const session = list.find((entry) => entry.text.split('\n')[0] === title)
  assert(session, `Session ${title} is missing from the sidebar`)
  await waitForLine(session.id, (line) => /\$\s*$/.test(line), 'shell prompt')
  return session
}

async function selectSession(sessionId) {
  await click(`[data-testid="session-item-${sessionId}"]`)
  await sleep(300)
}

function probeSource() {
  return `'use strict'
const net = require('node:net')
const mode = process.argv[2]
const socketPath = process.env.ICODE_ACTIVITY_SOCKET
const sessionId = process.env.ICODE_SESSION_ID
const incarnationId = process.env.ICODE_SESSION_INCARNATION
if (!socketPath || !sessionId || !incarnationId) {
  process.stderr.write('missing iCode session environment\\n')
  process.exit(2)
}
function send(event, options) {
  const payload = {
    event,
    sessionId,
    incarnationId,
    claudeSessionId: 'claude-activity-smoke',
    promptId: options.promptId,
    toolName: options.toolName ?? null,
    sentAt: options.sentAt ?? Date.now()
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.on('error', reject)
    socket.on('connect', () => socket.end(JSON.stringify(payload)))
    socket.on('close', resolve)
  })
}
async function main() {
  if (mode === 'working') {
    await send('PreToolUse', { toolName: 'Edit', promptId: 'smoke-p1' })
  } else if (mode === 'waiting') {
    await send('PermissionRequest', { toolName: 'Bash', promptId: 'smoke-p2' })
  } else if (mode === 'question') {
    await send('PreToolUse', { toolName: 'AskUserQuestion', promptId: 'smoke-p3' })
  } else if (mode === 'stale') {
    const fresh = Date.now()
    await send('PreToolUse', { toolName: 'Edit', promptId: 'smoke-p4', sentAt: fresh })
    await send('Stop', { promptId: 'smoke-old', sentAt: fresh - 5000 })
  } else if (mode === 'stop') {
    await send('Stop', { promptId: 'smoke-p4' })
  } else if (mode === 'failed') {
    await send('StopFailure', { promptId: 'smoke-p4' })
  } else {
    process.stderr.write('unknown mode ' + mode + '\\n')
    process.exit(2)
  }
}
main().then(() => process.exit(0), (error) => {
  process.stderr.write(String(error) + '\\n')
  process.exit(1)
})
`
}

async function main() {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  mkdirSync(REPO_DIR, { recursive: true })
  mkdirSync(CLAUDE_CONFIG, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: REPO_DIR })
  writeFileSync(join(REPO_DIR, 'README.md'), '# activity acceptance\n')
  execFileSync('git', ['add', 'README.md'], { cwd: REPO_DIR })
  execFileSync(
    'git',
    ['-c', 'user.email=icode@test', '-c', 'user.name=iCode', 'commit', '-qm', 'init'],
    { cwd: REPO_DIR }
  )

  // The isolated config is iCode's "user" Claude config: iCode must never edit it,
  // and the canary hook proves the --settings overlay is additive.
  writeFileSync(
    join(CLAUDE_CONFIG, 'settings.json'),
    `${JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: `echo CANARY_USER >> ${CANARY}` }] }],
          StopFailure: [{ hooks: [{ type: 'command', command: `echo CANARY_STOPFAILURE >> ${CANARY}` }] }]
        }
      },
      null,
      2
    )}\n`
  )
  const probePath = join(RUN_DIR, 'activity-probe.cjs')
  writeFileSync(probePath, probeSource())
  const realSettingsHashBefore = sha256(REAL_CLAUDE_SETTINGS)
  const isolatedSettingsHashBefore = sha256(join(CLAUDE_CONFIG, 'settings.json'))

  RUN.build = {
    executable: PACKAGED_EXE,
    userData: USER_DATA,
    hookDirectory: join(USER_DATA, 'agent-hooks'),
    xdgConfigHome: XDG_CONFIG,
    claudeConfigDir: CLAUDE_CONFIG,
    realClaudeSettings: REAL_CLAUDE_SETTINGS,
    realClaudeSettingsHashBefore: realSettingsHashBefore,
    isolatedSettingsHashBefore,
    gateOverrides: Object.keys(process.env).filter((key) => key.startsWith('ICODE_GATE_'))
  }
  persist()

  let first = null
  let second = null

  await step('launch the packaged app and verify the additive Hook overlay', 'AC1', async () => {
    await launch()
    const hookDir = join(USER_DATA, 'agent-hooks')
    const scriptPath = join(hookDir, 'icode-activity-hook.cjs')
    const settingsPath = join(hookDir, 'settings.json')
    assert(existsSync(scriptPath), 'The shipped Hook script was not installed')
    assert(existsSync(settingsPath), 'The Claude settings overlay was not installed')
    assert(
      (statSync(scriptPath).mode & 0o777) === 0o700,
      'Hook script permissions are not 0700'
    )
    const overlay = JSON.parse(readFileSync(settingsPath, 'utf8'))
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'Stop',
      'StopFailure'
    ]) {
      assert(Array.isArray(overlay.hooks?.[event]), `Overlay is missing ${event}`)
    }
    assert(!JSON.stringify(overlay).includes('Notification'), 'Overlay relies on Notification')
    const isolated = readFileSync(join(CLAUDE_CONFIG, 'settings.json'), 'utf8')
    assert(isolated.includes('CANARY_USER'), 'The user settings file was modified')
    RUN.overlay = { scriptPath, settingsPath, events: Object.keys(overlay.hooks) }
    await screenshot('01-launched')
    return { scriptPath, settingsPath }
  })

  await step('register the repository and open two shell sessions', 'AC2', async () => {
    await click('[data-testid="empty-add-repo"]')
    await setInput('[data-testid="add-repo-input"]', REPO_DIR)
    await click('[data-testid="add-repo-submit"]')
    await waitForNotice('Registered')
    first = await createShellSession('Activity A')
    second = await createShellSession('Activity B')
    const initial = await activityUi()
    assert(initial.sessionId === second.id, 'The newest session is not selected')
    assert(initial.header?.state === 'unknown', `Expected unknown, got ${initial.header?.state}`)
    assert(
      !String(initial.header?.text ?? '').includes('Activity unknown'),
      'The compact header still shows an unknown activity label'
    )
    assert(initial.sidebar?.state === 'unknown', 'The sidebar invents an activity state')
    assert(initial.marker === null, 'An unknown activity shows a sidebar marker')
    const other = (await sessions()).find((entry) => entry.id === first.id)
    assert(other?.activity === 'unknown', 'A fresh session does not start unknown')
    await screenshot('02-unknown')
    return { first, second, initial }
  })

  await step('show working with the tool name from PreToolUse', 'AC3', async () => {
    await selectSession(first.id)
    await typeLine(first.id, `node '${probePath}' working`)
    const ui = await waitForActivity('working', 'working activity')
    assert(ui.header?.tool === 'Edit', `Header tool is ${ui.header?.tool}`)
    assert(ui.header?.text.includes('Working · Edit'), `Header says ${ui.header?.text}`)
    assert(ui.sidebar?.text.includes('Working · Edit'), `Sidebar says ${ui.sidebar?.text}`)
    const other = (await sessions()).find((entry) => entry.id === second.id)
    assert(other?.activity === 'unknown', 'Activity leaked into the other session')
    await screenshot('03-working')
    return ui
  })

  await step('show waiting and clear unread while the window is focused', 'AC4', async () => {
    await typeLine(first.id, `node '${probePath}' waiting`)
    await waitForActivity('waiting', 'waiting activity')
    const ui = await activityUi()
    assert(ui.header?.text.includes('Needs you'), `Header says ${ui.header?.text}`)
    assert(ui.sidebar?.text.includes('Needs you'), `Sidebar says ${ui.sidebar?.text}`)
    if (ui.focused) {
      await waitFor(
        `document.querySelector('[data-testid="session-activity"]')?.getAttribute('data-activity-unread') === 'false'`,
        'unread to clear in a focused window',
        15000
      )
      const cleared = await activityUi()
      assert(cleared.sidebar?.unread === 'false', 'Sidebar keeps the unread flag')
      assert(cleared.marker?.text.includes('Needs you'), 'Waiting text disappeared')
      const badge = await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="session-unread-${first.id}"]'))`
      )
      assert(!badge, 'The sidebar still renders the unread badge')
      RUN.notRun.notifications = 'OS notifications are not observable under WSLg/CDP; unit tests cover suppression and dedupe.'
      return { ui, unreadClearedWhileFocused: true }
    }
    RUN.notRun.notifications = 'The packaged window did not report focus, so clearing and notification behaviour were not exercised.'
    RUN.notRun.focusedUnread = 'The window did not report focus.'
    return { ui, unreadClearedWhileFocused: false }
  })

  await step('name AskUserQuestion as the reason the agent waits', 'AC4', async () => {
    await typeLine(first.id, `node '${probePath}' question`)
    await waitForActivity('waiting', 'question activity')
    const ui = await activityUi()
    assert(ui.header?.tool === 'AskUserQuestion', `Header tool is ${ui.header?.tool}`)
    assert(
      ui.header?.text.includes('Needs you · AskUserQuestion'),
      `Header says ${ui.header?.text}`
    )
    await screenshot('04-waiting')
    return ui
  })

  await step('reject a delayed Stop from an older turn', 'AC5', async () => {
    await typeLine(first.id, `node '${probePath}' stale`)
    await waitForActivity('working', 'working after stale Stop')
    await sleep(1200)
    const ui = await activityUi()
    assert(ui.header?.state === 'working', `A late Stop changed the state to ${ui.header?.state}`)
    assert(ui.header?.tool === 'Edit', `A late Stop changed the tool to ${ui.header?.tool}`)
    const appLog = readFileSync(join(ARTIFACT_DIR, 'app.log'), 'utf8')
    assert(
      /activity event rejected \((stale-event|stale-turn)\)/.test(appLog),
      'The delayed Stop was not rejected by ordering'
    )
    await screenshot('05-stale-rejected')
    return { ui, rejectedInLog: true }
  })

  await step('end the turn as completed and then failed', 'AC5', async () => {
    await typeLine(first.id, `node '${probePath}' stop`)
    await waitForActivity('idle', 'idle after Stop')
    let ui = await activityUi()
    assert(ui.header?.text.includes('Done'), `Header says ${ui.header?.text}`)
    assert(ui.sidebar?.text.includes('Done'), `Sidebar says ${ui.sidebar?.text}`)
    assert(!ui.header?.text.includes('failed'), 'A completed turn is shown as failed')

    await typeLine(first.id, `node '${probePath}' failed`)
    await waitFor(
      `document.querySelector('[data-testid="session-activity"]')?.innerText.includes('Done · failed')`,
      'failed outcome',
      15000
    )
    ui = await activityUi()
    assert(ui.header?.text.includes('Done · failed'), `Header says ${ui.header?.text}`)
    await screenshot('06-done-failed')
    return ui
  })

  await step('receive activity from the real claude CLI through the overlay', 'AC6', async () => {
    let claudeVersion = null
    try {
      claudeVersion = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim()
    } catch {
      RUN.notRun.realClaude = 'The claude CLI is not installed in this environment.'
      RUN.criteria.AC6 = 'NOT RUN'
      persist()
      return { skipped: true }
    }
    await selectSession(second.id)
    await waitForActivity('unknown', 'unknown before Claude runs')
    const settingsPath = join(USER_DATA, 'agent-hooks', 'settings.json')
    await typeLine(
      second.id,
      `claude --settings '${settingsPath}' -p 'Reply with OK'`
    )
    // The isolated config is unauthenticated, so the turn ends failed. Either
    // idle outcome proves real Hook dispatch; the canary proves user hooks ran.
    await sleep(3000)
    const early = {
      rows: (await rows(second.id)).filter((line) => line.trim().length > 0).slice(-8),
      ui: await activityUi()
    }
    try {
      await waitFor(
        `document.querySelector('[data-testid="session-activity"]')?.getAttribute('data-activity') === 'idle'`,
        'real Claude to finish a turn',
        90000
      )
    } catch (error) {
      const lateRows = (await rows(second.id)).filter((line) => line.trim().length > 0).slice(-12)
      throw new Error(`${String(error)}; early=${JSON.stringify(early)}; rows=${JSON.stringify(lateRows)}`)
    }
    const ui = await activityUi()
    assert(ui.header?.tool === null || ui.header?.tool === '', 'Idle still names a tool')
    assert(existsSync(CANARY), 'The user canary hook never ran')
    const canary = readFileSync(CANARY, 'utf8')
    assert(canary.includes('CANARY_USER'), 'The user UserPromptSubmit hook did not run')
    assert(
      sha256(join(CLAUDE_CONFIG, 'settings.json')) === isolatedSettingsHashBefore,
      'iCode changed the user Claude settings'
    )
    assert(
      sha256(REAL_CLAUDE_SETTINGS) === realSettingsHashBefore,
      'iCode changed ~/.claude/settings.json'
    )
    await screenshot('07-real-claude')
    return { claudeVersion, ui, canary: canary.trim().split('\n').slice(0, 4) }
  })

  await step('keep activity out of lifecycle and reset it when the process ends', 'AC7', async () => {
    await selectSession(first.id)
    await typeLine(first.id, 'exit')
    await waitFor(
      `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === 'exited'`,
      'session to exit',
      20000
    )
    await waitForActivity('unknown', 'activity to reset after exit')
    const ui = await activityUi()
    assert(ui.header?.state === 'unknown', 'Exited session did not reset activity')
    assert(
      !/Working|Needs you|Done/u.test(String(ui.header?.text ?? '')),
      'Exited session keeps a visible stale activity'
    )
    assert(
      (await sessions()).find((entry) => entry.id === second.id)?.activity === 'idle',
      'Stopping one session changed another session activity'
    )
    await screenshot('08-lifecycle-independent')
    return ui
  })

  await step('clean up without touching the primary checkout or user config', 'AC8', async () => {
    await selectSession(second.id)
    await typeLine(second.id, 'exit')
    await waitFor(
      `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === 'exited'`,
      'second session to exit',
      20000
    )
    await quitApp()
    const meta = hostMeta()
    hostPid = meta?.pid ?? null
    assert(hostPid && pidAlive(hostPid), 'The test Host stopped before cleanup')
    try {
      process.kill(hostPid, 'SIGTERM')
    } catch {
      // already gone
    }
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && pidAlive(hostPid)) await sleep(200)
    assert(!pidAlive(hostPid), 'The test Host is still running')

    const status = execFileSync('git', ['-C', REPO_DIR, 'status', '--porcelain'], {
      encoding: 'utf8'
    }).trim()
    assert(status === '', `Primary checkout is dirty: ${status}`)
    assert(
      sha256(REAL_CLAUDE_SETTINGS) === realSettingsHashBefore,
      'The real ~/.claude/settings.json changed during the run'
    )

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
    return { hostPid, primaryCheckoutClean: true, realClaudeSettingsHash: realSettingsHashBefore }
  })

  RUN.finishedAt = new Date().toISOString()
  RUN.status = 'passed'
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
    // A failed run may never reach the cleanup step; the detached Host is
    // recorded on disk, so a failure must still stop it.
    const meta = hostMeta()
    if (meta?.pid) hostPid = meta.pid
    try {
      if (hostPid && pidAlive(hostPid)) process.kill(hostPid, 'SIGTERM')
    } catch {
      // already gone
    }
    process.exitCode = 1
  } finally {
    persist()
    log(`evidence: ${join(ARTIFACT_DIR, 'activity-smoke.json')}`)
    log(`status: ${RUN.status}`)
  }
}

void run()
