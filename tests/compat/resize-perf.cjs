'use strict'
/**
 * Drag-performance probe for the resizable seams.
 *
 * Report-only: it records frame intervals and long tasks for sidebar width,
 * the Projects/Tasks split, inspector, Files list, SCM list, and split-divider
 * drags, and asserts the behavioural invariants that made the drag cheap:
 *   - the seam follows the pointer before release,
 *   - localStorage is untouched during the drag and written once after,
 *   - aria-valuenow tracks the live width.
 *
 * It launches a real Electron window against an isolated profile and a
 * throwaway repository, creates two Shell sessions, and drives the seams with
 * trusted CDP mouse events. Results land in artifacts/resize-perf/report.json.
 *
 * Run: node tests/compat/resize-perf.cjs
 */
const { spawn } = require('node:child_process')
const { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const ELECTRON = require('electron')
const ARTIFACT_DIR = join(APP_DIR, 'artifacts', 'resize-perf')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'icode-resize-perf-'))
const REPO_DIR = join(RUN_DIR, 'repo')
const USER_DATA = join(RUN_DIR, 'userdata')
const HOST_DIR = join(RUN_DIR, 'host')
const PORT = 26_100 + (process.pid % 400)

const SIDEBAR_KEY = 'icode.workspace.sidebar.width.v1'
const INSPECTOR_KEY = 'icode.inspector.width.v1'
const FILES_KEY = 'icode.files.settings.v1'
const SCM_KEY = 'icode.scm.settings.v1'

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
let logStream = null

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function log(message) {
  process.stdout.write(`[resize-perf] ${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function prepareRunDir() {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(REPO_DIR, { recursive: true })
  const { execFileSync } = require('node:child_process')
  writeFileSync(join(REPO_DIR, 'README.md'), '# resize perf fixture\n')
  mkdirSync(join(REPO_DIR, 'src'), { recursive: true })
  writeFileSync(join(REPO_DIR, 'src', 'app.ts'), 'export const value = 1\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['add', '.'], { cwd: REPO_DIR })
  execFileSync(
    'git',
    ['-c', 'user.email=icode@example.test', '-c', 'user.name=iCode', 'commit', '-qm', 'fixture'],
    { cwd: REPO_DIR }
  )
}

async function launch() {
  const logPath = join(ARTIFACT_DIR, 'app.log')
  logStream = createWriteStream(logPath)
  RUN.log = logPath
  appProcess = spawn(
    ELECTRON,
    [
      '.',
      `--remote-debugging-port=${PORT}`,
      // A perf probe must not measure Chromium's occlusion throttling. These
      // keep rAF at display cadence even when the window is behind the console.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion'
    ],
    {
      cwd: APP_DIR,
      env: {
        ...process.env,
        ICODE_GATE_USER_DATA: USER_DATA,
        ICODE_BACKGROUND_LAUNCH: '0',
        // Let the app derive the endpoint: a POSIX path on Unix, a named pipe on
        // Windows. Passing ICODE_HOST_SOCKET here is what broke ui-smoke there.
        ICODE_HOST_DIR: HOST_DIR
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  appProcess.stdout.pipe(logStream)
  appProcess.stderr.pipe(logStream)
  appProcess.on('exit', (code, signal) => {
    log(`app exited code=${code} signal=${signal}`)
  })
  cdp = await connect(PORT)
  // A background/occluded window is rAF-throttled to roughly 1 fps, which makes
  // every live-drag sample meaningless. Keep the probe window in front.
  await cdp.send('Page.bringToFront').catch(() => undefined)
  await waitForSelector('[data-testid="workspace-sidebar"]', 30_000)
  await waitFor(
    `Boolean(document.querySelector('[data-testid^="project-row-"]')) || Boolean(document.querySelector('[data-testid="empty-workspace"]'))`,
    'workspace shell',
    30_000
  )
}

async function quitApp() {
  if (cdp !== null) {
    try {
      await cdp.evaluate('window.close()')
    } catch {
      // The page can disappear before it answers.
    }
  }
  await sleep(1500)
  if (appProcess !== null) {
    try {
      appProcess.kill()
    } catch {
      // Already gone.
    }
  }
  // The terminal host is detached; stop it so the run leaves nothing behind.
  try {
    const meta = JSON.parse(readFileSync(join(HOST_DIR, 'meta.json'), 'utf8'))
    if (typeof meta.pid === 'number') process.kill(meta.pid)
  } catch {
    // No host, or it already exited.
  }
  if (cdp !== null) {
    try {
      cdp.close()
    } catch {
      // Already closed.
    }
  }
  cdp = null
  appProcess = null
  if (logStream !== null) logStream.end()
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

async function sessions() {
  return cdp.evaluate(`(async () => {
    const result = await window.icode.sessions.list({});
    return result.ok ? result.value.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      state: session.state,
      harness: session.harness,
      worktreePath: session.worktree?.path ?? null
    })) : result;
  })()`)
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
  const repoId = await cdp.evaluate(
    `document.querySelector('[data-testid^="project-row-"]')?.getAttribute('data-testid')?.replace('project-row-', '') ?? null`
  )
  assert(repoId, 'Project row is missing its repository id')
  return repoId
}

async function createSession(title) {
  await click('[data-testid="sidebar-new-menu"]')
  await waitForSelector('[data-testid="new-session-open"]', 10_000)
  await click('[data-testid="new-session-open"]')
  await waitForSelector('[data-testid="new-session-repo"]', 15_000)
  await click('[data-testid="harness-option-shell"]')
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
    `!document.querySelector('[data-testid="new-session-repo"]')`,
    'the new-session dialog to close',
    15_000
  )
}

async function startProbe() {
  await cdp.evaluate(`(() => {
    const probe = { frames: [], longTasks: [], running: true };
    window.__icodeResizeProbe = probe;
    const tick = (time) => {
      if (!probe.running) return;
      probe.frames.push(time);
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
    try {
      probe.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) probe.longTasks.push(entry.duration);
      });
      probe.observer.observe({ entryTypes: ['longtask'] });
    } catch {}
    return true;
  })()`)
}

async function stopProbe() {
  return cdp.evaluate(`(() => {
    const probe = window.__icodeResizeProbe;
    if (!probe) return null;
    probe.running = false;
    try { probe.observer?.disconnect(); } catch {}
    const gaps = [];
    for (let i = 1; i < probe.frames.length; i += 1) {
      gaps.push(probe.frames[i] - probe.frames[i - 1]);
    }
    gaps.sort((a, b) => a - b);
    const at = (q) => gaps.length === 0 ? 0 : gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))];
    return {
      frames: probe.frames.length,
      p50: Math.round(at(0.5) * 10) / 10,
      p95: Math.round(at(0.95) * 10) / 10,
      max: gaps.length === 0 ? 0 : Math.round(gaps[gaps.length - 1] * 10) / 10,
      longTasks: probe.longTasks.length,
      longestTask: probe.longTasks.length === 0 ? 0 : Math.round(Math.max(...probe.longTasks))
    };
  })()`)
}

async function seamRect(selector) {
  return cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      width: rect.width,
      height: rect.height,
      hit: hit === null ? null : (hit.getAttribute('data-testid') ?? hit.tagName),
      contained: hit !== null && (hit === element || element.contains(hit))
    };
  })()`)
}

async function drag(selector, deltaX, deltaY, during) {
  const start = await seamRect(selector)
  assert(start !== null, `Missing seam ${selector}`)
  assert(
    start.contained,
    `Seam ${selector} is covered at its center (hit: ${JSON.stringify(start.hit)})`
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: start.x,
    y: start.y,
    button: 'none',
    buttons: 0
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: start.x,
    y: start.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  const steps = 24
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x + (deltaX * step) / steps,
      y: start.y + (deltaY * step) / steps,
      button: 'left',
      buttons: 1
    })
    await sleep(16)
  }
  // The hook applies on rAF; give the last move one frame before sampling.
  await sleep(64)
  const mid = during === undefined ? null : await during()
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: start.x + deltaX,
    y: start.y + deltaY,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
  await sleep(250)
  return { mid, seam: { width: start.width, hit: start.hit } }
}

async function sidebarState() {
  return cdp.evaluate(`(() => {
    const aside = document.querySelector('[data-testid="workspace-sidebar"]');
    const seam = document.querySelector('[data-testid="sidebar-resizer"]');
    const refresh = document.querySelector('[data-testid="sidebar-refresh"]');
    return {
      width: aside === null ? 0 : Math.round(aside.getBoundingClientRect().width),
      storage: window.localStorage.getItem(${JSON.stringify(SIDEBAR_KEY)}),
      aria: seam?.getAttribute('aria-valuenow') ?? null,
      compact: aside?.getAttribute('data-compact') ?? null,
      refreshDisplay: refresh === null ? null : getComputedStyle(refresh).display
    };
  })()`)
}

async function inspectorState() {
  return cdp.evaluate(`(() => {
    const aside = document.querySelector('[data-testid="session-inspector"]');
    return {
      width: aside === null ? 0 : Math.round(aside.getBoundingClientRect().width),
      storage: window.localStorage.getItem(${JSON.stringify(INSPECTOR_KEY)})
    };
  })()`)
}

async function settingsState(key, field) {
  return cdp.evaluate(`(() => {
    const raw = window.localStorage.getItem(${JSON.stringify(key)});
    let value = null;
    try {
      value = raw === null ? null : JSON.parse(raw)[${JSON.stringify(field)}] ?? null;
    } catch {}
    return { raw, value };
  })()`)
}

async function keepFront() {
  await cdp.send('Page.bringToFront').catch(() => undefined)
  await cdp.evaluate('window.focus()').catch(() => undefined)
  await sleep(100)
}

/**
 * Startup work (Harness probing, first repository load) can monopolize the
 * renderer for a while. A perf sample taken then measures the startup, not the
 * seam, so wait for a healthy frame cadence first.
 */
async function waitForCalm(label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let sample = null
    try {
      sample = await cdp.evaluate(`new Promise((resolve) => {
        const frames = [];
        const start = performance.now();
        const tick = (time) => {
          frames.push(time);
          if (time - start < 750) {
            window.requestAnimationFrame(tick);
          } else {
            const gaps = [];
            for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i] - frames[i - 1]);
            resolve({
              frames: frames.length,
              max: gaps.length === 0 ? 0 : Math.max(...gaps)
            });
          }
        };
        window.requestAnimationFrame(tick);
      })`)
    } catch {
      sample = null
    }
    if (sample !== null && sample.frames >= 30 && sample.max < 100) {
      return sample
    }
    await sleep(500)
  }
  throw new Error(`The renderer did not become idle before ${label}`)
}

async function measureScenario(name, work) {
  const startedAt = Date.now()
  log(name)
  try {
    await keepFront()
    await waitForCalm(name)
    const details = await work()
    RUN.scenarios.push({
      name,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      ...details
    })
    return details
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    RUN.scenarios.push({
      name,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: message
    })
    RUN.failures.push(`${name}: ${message}`)
    return null
  }
}

async function scenarioSidebar(deltaX = 140) {
  const before = await sidebarState()
  await startProbe()
  const { mid, seam } = await drag('[data-testid="sidebar-resizer"]', deltaX, 0, sidebarState)
  const metrics = await stopProbe()
  const after = await sidebarState()

  const moved =
    deltaX >= 0
      ? mid.width >= before.width + 20
      : mid.width <= before.width - 20
  assert(moved, `Sidebar width did not follow the pointer (${before.width} -> ${mid.width})`)
  assert(mid.storage === before.storage, 'Sidebar width was persisted during the drag')
  assert(after.storage !== null, 'Sidebar width was not persisted on release')
  assert(Number(after.storage) === after.width, `Stored sidebar width ${after.storage} != rendered ${after.width}`)
  assert(after.aria === String(after.width), `Sidebar aria-valuenow ${after.aria} != ${after.width}`)

  if (process.platform === 'darwin' && after.width < 280) {
    assert(after.refreshDisplay === 'none', 'Compact sidebar did not hide the refresh verb')
  }

  // Return the workspace to its default width for the other scenarios.
  await drag('[data-testid="sidebar-resizer"]', deltaX >= 0 ? -100 : 60, 0)

  return { before, mid, after, metrics, seam }
}

async function scenarioInspector() {
  const before = await inspectorState()
  await startProbe()
  const { mid, seam } = await drag('[data-testid="inspector-resizer"]', -360, 0, inspectorState)
  const metrics = await stopProbe()
  const after = await inspectorState()

  assert(mid.width >= before.width + 40, `Inspector width did not follow the pointer (${before.width} -> ${mid.width})`)
  assert(mid.storage === before.storage, 'Inspector width was persisted during the drag')
  assert(after.storage !== null, 'Inspector width was not persisted on release')
  assert(Number(after.storage) === after.width, `Stored inspector width ${after.storage} != rendered ${after.width}`)

  return { before, mid, after, metrics, seam }
}

async function editorWidth() {
  return cdp.evaluate(
    `Math.round(document.querySelector('[data-testid="center-editor"]')?.getBoundingClientRect().width ?? 0)`
  )
}

async function openCenterFile() {
  await click('[data-testid="view-files"]')
  await waitForSelector('[data-testid="session-inspector"] [data-testid="files-tree"]', 15_000)
  await waitForSelector(
    '[data-testid="session-inspector"] [data-testid^="files-entry-README.md"]',
    15_000
  )
  const opened = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-testid="session-inspector"] [data-testid="files-entry-README.md"]');
    if (row === null) return false;
    row.click();
    return true;
  })()`)
  assert(opened, 'Could not open a file in the center editor')
  await waitForSelector('[data-testid="center-editor"]', 20_000)
  await waitForSelector('[data-testid="monaco-editor"]', 20_000)
  await waitForCalm('the center editor')
}

/**
 * The inspector seam now gives its width to the center editor, not to a
 * two-column Files/SCM detail. The drag contract is unchanged: the editor
 * follows the pointer immediately and only the release persists the width.
 */
async function scenarioCenterEditor() {
  await openCenterFile()
  const before = { ...(await inspectorState()), editor: await editorWidth() }
  await startProbe()
  const { mid } = await drag('[data-testid="inspector-resizer"]', -120, 0, async () => ({
    ...(await inspectorState()),
    editor: await editorWidth()
  }))
  const metrics = await stopProbe()
  const after = { ...(await inspectorState()), editor: await editorWidth() }

  assert(mid.width >= before.width + 40, `Inspector did not widen (${before.width} -> ${mid.width})`)
  assert(mid.editor <= before.editor - 20, `Editor did not yield width (${before.editor} -> ${mid.editor})`)
  assert(mid.storage === before.storage, 'Inspector width was persisted during the drag')
  assert(after.storage !== null, 'Inspector width was not persisted on release')
  assert(Number(after.storage) === after.width, `Stored width ${after.storage} != rendered ${after.width}`)

  await cdp.evaluate(`document.querySelector('[data-testid="inspector-resizer"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await sleep(250)
  return { before, mid, after, metrics }
}

async function scenarioInspectorLoaded() {
  // A center editor is mounted while the inspector is dragged. The editor must
  // reclaim the width only through the normal row layout, not a per-frame
  // relayout of its own.
  if (!(await cdp.evaluate(`Boolean(document.querySelector('[data-testid="center-editor"]'))`))) {
    await openCenterFile()
  }
  const before = { ...(await inspectorState()), editor: await editorWidth() }
  await startProbe()
  const { mid } = await drag('[data-testid="inspector-resizer"]', 360, 0, async () => ({
    ...(await inspectorState()),
    editor: await editorWidth()
  }))
  const metrics = await stopProbe()
  const after = { ...(await inspectorState()), editor: await editorWidth() }

  assert(
    mid.width <= before.width - 40,
    `Inspector width did not follow the pointer back (${before.width} -> ${mid.width})`
  )
  assert(mid.storage === before.storage, 'Inspector width was persisted during the drag')
  assert(after.storage !== null, 'Inspector width was not persisted on release')
  assert(Number(after.storage) === after.width, `Stored inspector width ${after.storage} != rendered ${after.width}`)
  assert(
    mid.editor >= before.editor + 40,
    `The center editor did not reclaim the width (${before.editor} -> ${mid.editor})`
  )
  assert(
    after.editor >= before.editor + 40,
    `The center editor did not keep the reclaimed width (${after.editor})`
  )

  // Back to the default for the bounds scenario.
  await cdp.evaluate(`document.querySelector('[data-testid="inspector-resizer"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await sleep(250)

  return { before, mid, after, metrics }
}

async function scenarioInspectorBounds() {
  const read = () => cdp.evaluate(`(() => {
    const aside = document.querySelector('[data-testid="session-inspector"]');
    const row = aside === null ? null : aside.parentElement?.parentElement;
    return {
      width: aside === null ? 0 : Math.round(aside.getBoundingClientRect().width),
      expectedMax: row === null ? 0 : Math.max(240, Math.min(2400, Math.floor(row.getBoundingClientRect().width) - 360)),
      rowProbe: row === null ? null : Math.round(row.getBoundingClientRect().width)
    };
  })()`)

  const before = await read()
  await drag('[data-testid="inspector-resizer"]', 200, 0)
  const atMin = await read()
  assert(atMin.width === 240, `Inspector minimum is ${atMin.width}, expected 240`)

  await drag('[data-testid="inspector-resizer"]', -600, 0)
  const atMax = await read()
  assert(
    Math.abs(atMax.width - atMax.expectedMax) <= 1,
    `Inspector maximum is ${atMax.width}, expected ${atMax.expectedMax} (before=${JSON.stringify(before)}, atMin=${JSON.stringify(atMin)}, atMax=${JSON.stringify(atMax)})`
  )

  // Back to Termio's default for the split scenario.
  await drag('[data-testid="inspector-resizer"]', atMax.width - 320, 0)
  const restored = await read()
  assert(restored.width === 320, `Inspector did not restore to 320 (${restored.width})`)

  return { before, atMin, atMax, restored }
}

async function scenarioSplit() {
  await click('[data-testid="session-split-toggle"]')
  await waitForSelector('[data-testid="session-split-divider"]', 20_000)
  await waitForCalm('the split panes')

  const read = () => cdp.evaluate(`(() => {
    const seam = document.querySelector('[data-testid="session-split-divider"]');
    const rect = seam === null ? null : seam.getBoundingClientRect();
    return {
      left: rect === null ? 0 : Math.round(rect.left),
      aria: seam?.getAttribute('aria-valuenow') ?? null
    };
  })()`)

  const before = await read()
  await startProbe()
  const { mid, seam } = await drag('[data-testid="session-split-divider"]', 120, 0, read)
  const metrics = await stopProbe()
  const after = await read()

  assert(mid.left >= before.left + 20, `Split divider did not follow the pointer (${before.left} -> ${mid.left})`)
  assert(mid.aria !== before.aria, `Split aria-valuenow did not move (${before.aria})`)

  return { before, mid, after, metrics, seam }
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

  const repoId = await registerRepo()
  RUN.repoId = repoId

  // The sidebar needs no session; measure it before session startup work can
  // compete with the pointer events.
  await measureScenario('sidebar', scenarioSidebar)

  await createSession('Resize perf one')
  await createSession('Resize perf two')
  await waitFor(
    `(async () => {
      const result = await window.icode.sessions.list({});
      return result.ok && result.value.sessions.length >= 2 &&
        result.value.sessions.every((session) => session.state === 'live');
    })()`,
    'two live sessions',
    25_000
  )
  await waitFor(
    `document.querySelectorAll('[data-testid^="terminal-pane-"][data-phase="live"]').length >= 1`,
    'a live terminal pane',
    20_000
  )
  await sleep(750)
  const sessionList = await sessions()
  assert(sessionList.length >= 2, `Expected two sessions, got ${sessionList.length}`)
  RUN.sessions = sessionList.length

  await measureScenario('inspector', scenarioInspector)
  await measureScenario('center-editor', scenarioCenterEditor)
  await measureScenario('sidebar-loaded', () => scenarioSidebar(-60))
  await measureScenario('inspector-loaded', scenarioInspectorLoaded)
  await measureScenario('inspector-bounds', scenarioInspectorBounds)
  await measureScenario('split', scenarioSplit)

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
      process.exitCode = 1
    } else {
      log('all seams passed')
    }
  })
