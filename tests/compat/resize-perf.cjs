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
const SIDEBAR_TASKS_KEY = 'icode.workspace.sidebar.tasksHeight.v1'
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

async function sidebarSectionsState() {
  return cdp.evaluate(`(() => {
    const pane = document.querySelector('[data-testid="sidebar-tasks"]');
    const seam = document.querySelector('[data-testid="sidebar-sections-resizer"]');
    return {
      height: pane === null ? 0 : Math.round(pane.getBoundingClientRect().height),
      storage: window.localStorage.getItem(${JSON.stringify(SIDEBAR_TASKS_KEY)}),
      aria: seam?.getAttribute('aria-valuenow') ?? null
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

async function scenarioSidebarSections(deltaY = -80) {
  const before = await sidebarSectionsState()
  assert(before.height > 0, 'The Tasks pane has no height to resize')
  await startProbe()
  const { mid, seam } = await drag(
    '[data-testid="sidebar-sections-resizer"]',
    0,
    deltaY,
    sidebarSectionsState
  )
  const metrics = await stopProbe()
  const after = await sidebarSectionsState()

  const moved =
    deltaY < 0 ? mid.height >= before.height + 20 : mid.height <= before.height - 20
  assert(
    moved,
    `Tasks height did not follow the pointer (${before.height} -> ${mid.height})`
  )
  assert(mid.storage === before.storage, 'Tasks height was persisted during the drag')
  assert(after.storage !== null, 'Tasks height was not persisted on release')
  assert(
    Number(after.storage) === after.height,
    `Stored Tasks height ${after.storage} != rendered ${after.height}`
  )
  assert(
    after.aria === String(after.height),
    `Tasks aria-valuenow ${after.aria} != ${after.height}`
  )

  // Double-click returns the pane to content-sized for the later scenarios.
  await cdp.evaluate(`(() => {
    const seam = document.querySelector('[data-testid="sidebar-sections-resizer"]');
    seam?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`)
  await sleep(250)
  const reset = await sidebarSectionsState()
  assert(reset.storage === null, 'Double-click did not clear the Tasks height preference')
  assert(reset.aria !== null, 'Tasks aria-valuenow is missing after the reset')

  return { before, mid, after, reset, metrics, seam }
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

async function openFileAndResizeList() {
  await click('[data-testid="view-files"]')
  await waitForSelector('[data-testid="session-inspector"] [data-testid="files-tree"]', 15_000)
  await waitForSelector(
    '[data-testid="session-inspector"] [data-testid^="files-entry-README.md"]',
    15_000
  )
  await click('[data-testid="session-inspector"] [data-testid^="files-entry-README.md"]')
  await waitForSelector(
    '[data-testid="session-inspector"] [data-testid="files-list-resizer"]',
    20_000
  )
  // The first commit flips to two columns; sample only after the list has its
  // own (bounded) width rather than the transient flex-1 width.
  await waitFor(
    `(() => {
      const column = document.querySelector('[data-testid="session-inspector"] [data-testid="files-list-column"]');
      if (column === null) return false;
      const width = column.getBoundingClientRect().width;
      return width >= 180 && width <= 460;
    })()`,
    'the Files list to settle into its column',
    5_000
  )
  await sleep(150)
  await waitForCalm('the opened editor')

  const before = await settingsState(FILES_KEY, 'listWidth')
  const renderedBefore = await cdp.evaluate(
    `Math.round(document.querySelector('[data-testid="session-inspector"] [data-testid="files-list-column"]').getBoundingClientRect().width)`
  )
  await startProbe()
  const { mid, seam } = await drag(
    '[data-testid="session-inspector"] [data-testid="files-list-resizer"]',
    80,
    0,
    async () => ({
      width: await cdp.evaluate(
        `Math.round(document.querySelector('[data-testid="session-inspector"] [data-testid="files-list-column"]').getBoundingClientRect().width)`
      ),
      storage: await settingsState(FILES_KEY, 'listWidth')
    })
  )
  const metrics = await stopProbe()
  const after = await settingsState(FILES_KEY, 'listWidth')
  const renderedAfter = await cdp.evaluate(
    `Math.round(document.querySelector('[data-testid="session-inspector"] [data-testid="files-list-column"]').getBoundingClientRect().width)`
  )

  assert(mid.width >= renderedBefore + 20, `Files list did not follow the pointer (${renderedBefore} -> ${mid.width})`)
  assert(mid.storage.raw === before.raw, 'Files list width was persisted during the drag')
  assert(after.value !== null, 'Files list width was not persisted on release')
  assert(Number(after.value) === renderedAfter, `Stored files list width ${after.value} != rendered ${renderedAfter}`)

  return { renderedBefore, mid, renderedAfter, metrics, seam }
}

async function makeWorktreeChanges(sessionList) {
  const { execFileSync } = require('node:child_process')
  const paths = [...new Set(sessionList.map((session) => session.worktreePath).filter(Boolean))]
  assert(paths.length > 0, 'No session worktree path to write a change into')
  for (const path of paths) {
    writeFileSync(join(path, 'perf-change.txt'), 'resize perf change\n')
    try {
      execFileSync('git', ['-C', path, 'add', 'perf-change.txt'], { stdio: 'pipe' })
    } catch {
      // Staging is not required; the untracked row is enough.
    }
  }
  return paths
}

async function scenarioScmList(sessionList) {
  const paths = await makeWorktreeChanges(sessionList)
  await click('[data-testid="view-changes"]')
  await waitForSelector('[data-testid="session-inspector"] [data-testid="working-tree"]', 15_000)
  await waitFor(
    `Boolean(document.querySelector('[data-testid="session-inspector"] [data-testid^="working-file-"]'))`,
    'the working-tree change row',
    25_000
  )
  const opened = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-testid="session-inspector"] [data-testid^="working-file-"] button[data-scm-row="file"]');
    if (row === null) return false;
    row.click();
    return true;
  })()`)
  assert(opened, 'Could not open the SCM change')
  await waitForSelector(
    '[data-testid="session-inspector"] [data-testid="scm-sidebar-resizer"]',
    20_000
  )
  // The diff mounts after the row click; let the two-column layout settle.
  await waitFor(
    `(() => {
      const list = document.querySelector('[data-testid="session-inspector"] [data-testid="working-tree"] [role="tree"]');
      if (list === null) return false;
      const width = list.getBoundingClientRect().width;
      return width >= 180 && width <= 460;
    })()`,
    'the SCM list to settle into its column',
    5_000
  )
  await sleep(300)
  await waitForCalm('the loaded diff')

  const before = await settingsState(SCM_KEY, 'sidebarWidth')
  const layout = await cdp.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="session-inspector"] [data-testid="working-tree"]');
    const list = document.querySelector('[data-testid="session-inspector"] [data-testid="working-tree"] [role="tree"]');
    const inspector = document.querySelector('[data-testid="session-inspector"]');
    const sidebar = document.querySelector('[data-testid="workspace-sidebar"]');
    return {
      innerWidth: window.innerWidth,
      sidebar: sidebar === null ? 0 : Math.round(sidebar.getBoundingClientRect().width),
      inspector: inspector === null ? 0 : Math.round(inspector.getBoundingClientRect().width),
      panel: panel === null ? 0 : Math.round(panel.getBoundingClientRect().width),
      list: list === null ? 0 : Math.round(list.getBoundingClientRect().width)
    };
  })()`)
  const renderedBefore = layout.list
  await startProbe()
  const { mid, seam } = await drag(
    '[data-testid="session-inspector"] [data-testid="scm-sidebar-resizer"]',
    80,
    0,
    async () => ({
      width: await cdp.evaluate(
        `Math.round(document.querySelector('[data-testid="session-inspector"] [data-testid="working-tree"] [role="tree"]').getBoundingClientRect().width)`
      ),
      storage: await settingsState(SCM_KEY, 'sidebarWidth')
    })
  )
  const metrics = await stopProbe()
  const after = await settingsState(SCM_KEY, 'sidebarWidth')
  const renderedAfter = await cdp.evaluate(
    `Math.round(document.querySelector('[data-testid="session-inspector"] [data-testid="working-tree"] [role="tree"]').getBoundingClientRect().width)`
  )

  assert(mid.width >= renderedBefore + 20, `SCM list did not follow the pointer (${renderedBefore} -> ${mid.width})`)
  assert(mid.storage.raw === before.raw, 'SCM list width was persisted during the drag')
  assert(after.value !== null, 'SCM list width was not persisted on release')
  assert(Number(after.value) === renderedAfter, `Stored SCM list width ${after.value} != rendered ${renderedAfter}`)

  return { paths, layout, renderedBefore, mid, renderedAfter, metrics, seam }
}

async function scenarioInspectorLoaded() {
  // The Files editor and the SCM diff are mounted, with Changes active.
  // Shrinking back across INSPECTOR_TWO_COLUMN_MIN (600) is the case the width
  // deferral exists for: the diff pane must not relayout on every pointer
  // frame, only once at release.
  await waitForSelector(
    '[data-testid="session-inspector"] [data-testid="scm-sidebar-resizer"]',
    10_000
  )
  const before = await inspectorState()
  await startProbe()
  const { mid, seam } = await drag(
    '[data-testid="inspector-resizer"]',
    360,
    0,
    async () => ({
      ...(await inspectorState()),
      scmResizer: await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="session-inspector"] [data-testid="scm-sidebar-resizer"]'))`
      )
    })
  )
  const metrics = await stopProbe()
  const after = await inspectorState()
  const afterResizer = await cdp.evaluate(
    `Boolean(document.querySelector('[data-testid="session-inspector"] [data-testid="scm-sidebar-resizer"]'))`
  )

  assert(
    mid.width <= before.width - 40,
    `Inspector width did not follow the pointer back (${before.width} -> ${mid.width})`
  )
  assert(mid.storage === before.storage, 'Inspector width was persisted during the drag')
  assert(after.storage !== null, 'Inspector width was not persisted on release')
  assert(Number(after.storage) === after.width, `Stored inspector width ${after.storage} != rendered ${after.width}`)
  assert(
    mid.scmResizer === true,
    'The SCM pane flipped to one column during the drag instead of on release'
  )
  assert(afterResizer === false, 'The SCM pane did not flip to one column on release')

  return { before, mid, after, afterResizer, metrics, seam }
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

async function scenarioListBounds(name, panelSelector, seamSelector, columnSelector, selectorTestid) {
  const read = () => cdp.evaluate(`(() => {
    const column = document.querySelector(${JSON.stringify(columnSelector)});
    return Math.round(column.getBoundingClientRect().width);
  })()`)
  const expectedMax = await cdp.evaluate(`(() => {
    const panel = document.querySelector(${JSON.stringify(panelSelector)});
    return Math.max(180, Math.min(460, Math.floor(panel.getBoundingClientRect().width) - 260));
  })()`)

  const before = await read()
  await drag(seamSelector, -400, 0)
  const atMin = await read()
  assert(atMin === 180, `${name} minimum is ${atMin}, expected 180`)

  await drag(seamSelector, 400, 0)
  const atMax = await read()
  assert(Math.abs(atMax - expectedMax) <= 1, `${name} maximum is ${atMax}, expected ${expectedMax}`)

  await drag(seamSelector, 240 - atMax, 0)
  const restored = await read()
  assert(restored === 240, `${name} did not restore to 240 (${restored})`)

  return { testid: selectorTestid, before, atMin, atMax, expectedMax, restored }
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
  await measureScenario('sidebar-sections', scenarioSidebarSections)

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
  await measureScenario('files-list', openFileAndResizeList)
  await measureScenario('files-list-bounds', () =>
    scenarioListBounds(
      'Files list',
      '[data-testid="session-inspector"] [data-testid="files-panel"]',
      '[data-testid="session-inspector"] [data-testid="files-list-resizer"]',
      '[data-testid="session-inspector"] [data-testid="files-list-column"]',
      'files-list-resizer'
    )
  )
  await measureScenario('scm-list', () => scenarioScmList(sessionList))
  await measureScenario('scm-list-bounds', () =>
    scenarioListBounds(
      'SCM list',
      '[data-testid="session-inspector"] [data-testid="working-tree"]',
      '[data-testid="session-inspector"] [data-testid="scm-sidebar-resizer"]',
      '[data-testid="session-inspector"] [data-testid="working-tree"] [role="tree"]',
      'scm-sidebar-resizer'
    )
  )
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
