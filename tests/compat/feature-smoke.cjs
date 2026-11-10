'use strict'
/**
 * Real-Electron acceptance for the post-prototype gap slice.
 *
 * Covers the command palette, notifications, session details, the Git operation
 * hierarchy, schedule create/edit/delete, review drafts through commit/amend,
 * and TaskWorkbench pane continuity. Screenshots and a JSON result live under
 * artifacts/feature-smoke/.
 */
const { spawn } = require('node:child_process')
const {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const ELECTRON = require('electron')
const ARTIFACT_DIR = join(APP_DIR, 'artifacts', 'feature-smoke')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'icode-feature-smoke-'))
const REPO_DIR = join(RUN_DIR, 'repo')
const REMOTE_DIR = join(RUN_DIR, 'remote.git')
const USER_DATA = join(RUN_DIR, 'userdata')

mkdirSync(ARTIFACT_DIR, { recursive: true })

const RUN = {
  startedAt: new Date().toISOString(),
  runDir: RUN_DIR,
  steps: [],
  failures: [],
  artifacts: []
}

let appProcess = null
let cdp = null
let port = 20000 + Math.floor(Math.random() * 10000)
let repoId = null

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}
function log(message) {
  process.stdout.write(`[feature-smoke] ${message}\n`)
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
async function setValue(selector, value) {
  const applied = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const proto = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return element.value === ${JSON.stringify(value)};
  })()`)
  assert(applied, `Could not set ${selector}`)
}

async function setValueRetry(selector, value, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      await waitForSelector(selector, 1000)
      await setValue(selector, value)
      return
    } catch (error) {
      lastError = error
      await sleep(100)
    }
  }
  throw lastError ?? new Error(`Could not set ${selector}`)
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
async function key(selector, key) {
  const dispatched = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)}) || window;
    element.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
    return true;
  })()`)
  assert(dispatched, `Could not dispatch ${key}`)
}

async function clickWithModifiers(selector, modifiers = {}) {
  const clicked = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
      ...${JSON.stringify(modifiers)}
    }));
    return true;
  })()`)
  assert(clicked, `Could not modify-click ${selector}`)
}

async function rightClick(selector, x = 320, y = 320) {
  const clicked = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 2,
      clientX: ${x},
      clientY: ${y}
    }));
    return true;
  })()`)
  assert(clicked, `Could not right-click ${selector}`)
}

async function focusElement(selector) {
  const focused = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.focus();
    return true;
  })()`)
  assert(focused, `Could not focus ${selector}`)
}

async function dragAndDrop(fromSelector, toSelector) {
  const dropped = await cdp.evaluate(`(() => {
    const from = document.querySelector(${JSON.stringify(fromSelector)});
    const to = document.querySelector(${JSON.stringify(toSelector)});
    if (!from || !to) return false;
    const dataTransfer = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: 400, clientY: 400 }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: 400, clientY: 400 }));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
    return true;
  })()`)
  assert(dropped, `Could not drag ${fromSelector} to ${toSelector}`)
}
async function ctrlK() {
  await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`)
}

function git(...args) {
  require('node:child_process').execFileSync('git', ['-C', REPO_DIR, ...args], { stdio: 'pipe' })
}

async function launch() {
  const logPath = join(ARTIFACT_DIR, 'app.log')
  const logStream = createWriteStream(logPath)
  RUN.artifacts.push(logPath)
  appProcess = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      ICODE_GATE_USER_DATA: USER_DATA,
      ICODE_BACKGROUND_LAUNCH: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  appProcess.stdout.pipe(logStream)
  appProcess.stderr.pipe(logStream)
  appProcess.on('exit', (code, signal) => log(`app exited code=${code} signal=${signal}`))
  cdp = await connect(port)
  cdp.port = port
  await waitForSelector('[data-testid="app-rail"]', 30000)
  await waitFor(
    `Boolean(document.querySelector('[data-testid="projects-wall"]')) || Boolean(document.querySelector('[data-testid="empty-workspace"]'))`,
    'workspace wall',
    30000
  )
}

async function quit() {
  if (!cdp) {
    if (appProcess && appProcess.exitCode === null) {
      appProcess.kill('SIGTERM')
      await sleep(1000)
    }
    appProcess = null
    return
  }
  const currentPort = cdp.port
  try {
    await cdp.evaluate('window.close()')
  } catch {}
  await Promise.race([
    new Promise((done) => appProcess.once('exit', done)),
    sleep(6000)
  ])
  if (appProcess && appProcess.exitCode === null) appProcess.kill('SIGTERM')
  try {
    cdp.close()
  } catch {}
  cdp = null
  appProcess = null
  await sleep(250)
  port = currentPort + 1
}

async function openSessionWorkspace() {
  if (await cdp.evaluate(`Boolean(document.querySelector('[data-testid="project-sessions-list"]'))`)) return
  if (!(await cdp.evaluate(`Boolean(document.querySelector('[data-testid="projects-wall"]'))`))) {
    await click('[data-testid="rail-projects"]')
    await waitForSelector('[data-testid="projects-wall"]', 20000)
  }
  if (repoId === null) {
    repoId = await cdp.evaluate(
      `document.querySelector('[data-testid^="project-row-"]')?.getAttribute('data-testid')?.replace('project-row-', '') ?? null`
    )
  }
  assert(repoId, 'No repository lane')
  await click(`[data-testid="open-project-${repoId}"]`)
  await waitForSelector('[data-testid="project-header"]', 20000)
  await click('[data-testid="project-mode-sessions"]')
  await waitForSelector('[data-testid="project-sessions-list"]', 20000)
}

async function openChanges() {
  await click('[data-testid="view-changes"]')
  await waitForSelector('[data-testid="changes-panel"]', 20000)
  await waitFor(
    `Boolean(document.querySelector('[data-testid^="working-file-"]')) || document.querySelector('[data-testid="working-tree-empty"]') || document.querySelector('[data-testid="working-tree-unavailable"]')`,
    'working rows or empty state',
    20000
  )
}

async function run() {
  mkdirSync(REPO_DIR, { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'feature@smoke.test')
  git('config', 'user.name', 'Feature Smoke')
  writeFileSync(join(REPO_DIR, 'README.md'), 'feature smoke baseline\n')
  mkdirSync(join(REPO_DIR, 'src'), { recursive: true })
  writeFileSync(join(REPO_DIR, 'src', 'app.ts'), 'export const value = 1\n')
  git('add', '.')
  git('commit', '-qm', 'baseline')
  git('tag', 'v-baseline', 'HEAD')
  require('node:child_process').execFileSync('git', ['init', '-q', '--bare', REMOTE_DIR], { stdio: 'pipe' })
  git('remote', 'add', 'origin', REMOTE_DIR)
  git('push', '-q', '-u', 'origin', 'main')

  await launch()

  await step('register the smoke repository through the real dialog', async () => {
    await click('[data-testid="empty-add-repo"]')
    await waitForSelector('[data-testid="add-repo-form"]', 15000)
    await setValue('[data-testid="add-repo-input"]', REPO_DIR)
    await click('[data-testid="add-repo-submit"]')
    await waitForSelector('[data-testid="projects-wall"]', 20000)
    repoId = await cdp.evaluate(
      `document.querySelector('[data-testid^="project-row-"]')?.getAttribute('data-testid')?.replace('project-row-', '') ?? null`
    )
    assert(repoId, 'Repository was not registered')
    return { repoId }
  })

  await step('create a live Shell session and open Session details', async () => {
    await click('[data-testid="new-session-open"]')
    await waitForSelector('[data-testid="harness-option-shell"]', 20000)
    await click('[data-testid="harness-option-shell"]')
    await setValue('[data-testid="session-title-input"]', 'Smoke session')
    await click('[data-testid="create-session-submit"]')
    await waitFor(
      `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === 'live'`,
      'live session',
      25000
    )
    await click('[data-testid="session-menu"]')
    await waitForSelector('[data-testid="session-menu-popover"]', 10000)
    await click('[data-testid="session-details-open"]')
    await waitForSelector('[data-testid="session-details-drawer"]', 10000)
    await sleep(400)
    const text = await cdp.evaluate(`document.querySelector('[data-testid="session-details-drawer"]').innerText`)
    assert(text.includes('Smoke session') || text.includes('Session details'), 'Session details are empty')
    assert(text.includes('Harness'), 'Session details omitted the Harness')
    await screenshot('01-session-details')
    await click('[aria-label="Close session details"]')
    return { title: 'Smoke session' }
  })

  await step('open the command palette with Ctrl+K and search work and files', async () => {
    await ctrlK()
    await waitForSelector('[data-testid="command-palette"]', 10000)
    await sleep(200)
    assert(
      await cdp.evaluate(`Boolean(document.querySelector('[data-testid="command-group-action"]'))`),
      'Palette omitted the Actions group'
    )
    assert(
      await cdp.evaluate(
        `Array.from(document.querySelectorAll('[data-testid="command-palette-item"]')).every((el) => !el.innerText.split('\\n')[0].trim().endsWith('.git'))`
      ),
      'Palette exposed the worktree .git metadata'
    )
    await screenshot('02-command-palette-actions')
    await setValue('[data-testid="command-palette-input"]', 'Smoke')
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="command-palette-item"][data-kind="work"]')).some((el) => el.innerText.includes('Smoke session'))`,
      'work result in the palette',
      15000
    )
    await setValue('[data-testid="command-palette-input"]', 'README')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="command-palette-item"][data-kind="file"]'))`,
      'file result in the palette',
      20000
    )
    await screenshot('02-command-palette')
    await key('[data-testid="command-palette-input"]', 'Escape')
    await waitFor(
      `!document.querySelector('[data-testid="command-palette"]')`,
      'palette closed',
      5000
    )
  })

  await step('open the notification centre', async () => {
    await click('[data-testid="needs-you-bell"]')
    await waitForSelector('[data-testid="notifications-drawer"]', 10000)
    const text = (await cdp.evaluate(`document.querySelector('[data-testid="notifications-drawer"]').innerText`)).toLowerCase()
    assert(text.includes('needs you'), 'Notifications drawer omitted the Needs-you section')
    assert(text.includes('activity'), 'Notifications drawer omitted the Activity section')
    await sleep(400)
    await screenshot('03-notifications')
    await click('[aria-label="Close notifications"]')
  })

  let sessionId = null
  let worktreePath = null
  await step('commit and amend a change through Changes', async () => {
    const session = await cdp.evaluate(`(async () => {
      const result = await window.icode.sessions.list({});
      return result.ok ? result.value.sessions.find((entry) => entry.title === 'Smoke session') ?? null : null;
    })()`)
    assert(session, 'Could not find the smoke session through the product API')
    sessionId = session.id
    worktreePath = session.worktree?.path ?? null
    assert(worktreePath, 'The smoke session did not expose its worktree path')
    await cdp.evaluate(`(async () => {
      const result = await window.icode.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'README.md', text: 'changed by feature smoke\\n' });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    })()`)

    await openChanges()
    await waitForSelector('[data-testid="working-tree"]', 25000)
    await waitForSelector('[data-testid="working-file-unstaged-README.md"]', 25000)

    // Phase 1b: a local worktree must use the watcher, not the 2 s poll. Write
    // through the product API (main), then wait for a row that only the watcher
    // can deliver after the poll has been replaced.
    await waitFor(
      `document.querySelector('[data-testid="changes-panel"]')?.dataset.watchMode === 'watch'`,
      'local worktree watcher active',
      15000
    )
    await waitForSelector('[data-testid="statusbar-branch"]', 5000)
    const statusBranch = await cdp.evaluate(
      `document.querySelector('[data-testid="statusbar-branch"]')?.textContent ?? ''`
    )
    assert(statusBranch.includes('icode/ses_'), 'status bar did not show the session branch')
    await sleep(1200)
    const watchStarted = Date.now()
    await cdp.evaluate(`(async () => {
      const result = await window.icode.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'watcher-live.txt', text: 'written while Changes is open\\n' });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    })()`)
    await waitForSelector('[data-testid="working-file-untracked-watcher-live.txt"]', 8000)
    const watcherLatencyMs = Date.now() - watchStarted
    assert(watcherLatencyMs < 3000, `watcher took ${String(watcherLatencyMs)} ms`)

    await cdp.evaluate(`(async () => {
      const result = await window.icode.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'src/tree-live.txt', text: 'tree view row\\n' });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    })()`)
    await waitForSelector('[data-testid="working-file-untracked-src/tree-live.txt"]', 8000)

    // The commit input and session strip belong to the SCM sidebar.
    assert(
      await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="working-tree"] aside [data-testid="git-commit-message"]'))`
      ),
      'commit input must render inside the SCM sidebar'
    )
    assert(
      await cdp.evaluate(`Boolean(document.querySelector('[data-testid="scm-session-strip"]'))`),
      'the SCM sidebar is missing its session strip'
    )

    // Tree/list switching and filtering are part of the Phase 2 surface.
    await click('[data-testid="scm-view-tree"]')
    await waitForSelector('[data-testid="scm-folder-untracked-src"]', 5000)
    await click('[data-testid="scm-view-list"]')
    await waitFor(
      `!document.querySelector('[data-testid="scm-folder-untracked-src"]')`,
      'list view removes folder rows',
      5000
    )
    await setValue('[data-testid="working-tree-search"]', 'watcher-live')
    await waitFor(
      `!document.querySelector('[data-testid="working-file-unstaged-README.md"]')`,
      'filter removes non-matching rows',
      5000
    )
    await setValue('[data-testid="working-tree-search"]', '')
    await waitForSelector('[data-testid="working-file-unstaged-README.md"]', 5000)
    await setValue('[data-testid="scm-sort"]', 'name')
    await waitFor(
      `document.querySelector('[data-testid="scm-sort"]')?.value === 'name'`,
      'sort setting applied',
      5000
    )
    await setValue('[data-testid="scm-sort"]', 'path')

    // Source Control row menu: pointer-opened, keyboard-dismissed.
    await cdp.evaluate(`(() => {
      const row = document.querySelector('[data-testid="working-file-unstaged-README.md"]');
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 10 }));
      return true;
    })()`)
    await waitForSelector('[data-testid="scm-context-menu"]', 5000)
    const menuText = await cdp.evaluate(
      `document.querySelector('[data-testid="scm-context-menu"]')?.textContent ?? ''`
    )
    assert(menuText.includes('Open Changes'), 'context menu lacks Open Changes')
    assert(menuText.includes('Discard Changes'), 'context menu lacks Discard Changes')
    await cdp.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )
    await waitFor(
      `!document.querySelector('[data-testid="scm-context-menu"]')`,
      'Escape closes the context menu',
      5000
    )
    // Right-click selects the row; start the batch test from an empty selection.
    await click('[data-testid="scm-clear-selection"]')
    await waitFor(
      `!document.querySelector('[data-testid="scm-batch-bar"]')`,
      'selection cleared',
      5000
    )

    await click('[data-testid="scm-check-unstaged-README.md"]')
    await click('[data-testid="scm-check-untracked-watcher-live.txt"]')
    await waitForSelector('[data-testid="scm-batch-bar"]', 5000)
    const batchText = await cdp.evaluate(
      `document.querySelector('[data-testid="scm-batch-bar"]')?.textContent ?? ''`
    )
    if (!batchText.includes('2 selected')) {
      const state = await cdp.evaluate(`({
        batch: document.querySelector('[data-testid="scm-batch-bar"]')?.textContent ?? null,
        readme: document.querySelector('[data-testid="scm-check-unstaged-README.md"]')?.checked ?? null,
        watcher: document.querySelector('[data-testid="scm-check-untracked-watcher-live.txt"]')?.checked ?? null
      })`)
      throw new Error(`batch bar did not count both rows: ${JSON.stringify(state)}`)
    }
    await click('[data-testid="scm-stage-selected"]')
    await waitForSelector('[data-testid="working-file-staged-README.md"]', 15000)
    await waitForSelector('[data-testid="working-file-staged-watcher-live.txt"]', 15000)
    await click('[data-testid="change-stage-untracked-src/tree-live.txt"]')
    await waitForSelector('[data-testid="working-file-staged-src/tree-live.txt"]', 15000)
    await click('[data-testid="working-file-staged-README.md"] button[aria-selected]')
    await waitForSelector('[data-testid="review-diff-README.md"]', 15000)
    // The working diff defaults to the Monaco split; the smoke proves both
    // sides load, then switches to Unified for the note flow below.
    await waitForSelector('[data-testid="diff-view-split"]', 10000)
    await waitFor(
      `document.querySelector('[data-testid="diff-view-split"]')?.getAttribute('aria-pressed') === 'true'`,
      'working diff defaults to split view',
      10000
    )
    await waitForSelector('[data-testid="monaco-diff"]', 20000)
    await screenshot('05d-split-diff')
    await click('[data-testid="diff-view-unified"]')
    await waitForSelector('[data-testid^="diff-line-new-"]', 10000)
    await screenshot('05c-source-control')
    await waitForSelector('[data-testid="git-commit-message"]', 15000)
    await setValueRetry('[data-testid="git-commit-message"]', 'Feature smoke commit')

    // A review note and the commit message must survive a tab switch. The
    // Changes panel is hidden, not unmounted, and its draft lives in the store.
    await waitForSelector('[data-testid="review-diff-README.md"]', 15000)
    const diffLine = await cdp.evaluate(
      `document.querySelector('[data-testid^="diff-line-new-"]')?.dataset.testid ?? null`
    )
    assert(diffLine, 'No commentable diff line in README.md')
    await click(`[data-testid="${diffLine}"]`)
    await waitForSelector('[data-testid="line-comment-input"]', 10000)
    await setValue('[data-testid="line-comment-input"]', 'Keep this note')
    await click('[data-testid="line-comment-add"]')
    await waitForSelector('[data-testid^="line-comment-new-"]', 10000)
    await click('[data-testid="view-terminal"]')
    await sleep(300)
    await click('[data-testid="view-changes"]')
    await waitForSelector('[data-testid="git-commit-message"]', 15000)
    await waitFor(
      `document.querySelector('[data-testid="git-commit-message"]')?.value === 'Feature smoke commit'`,
      'commit-message draft survives a tab switch',
      10000
    )
    await waitForSelector('[data-testid^="line-comment-new-"]', 10000)

    await waitFor(
      `!document.querySelector('[data-testid="git-commit"]').disabled`,
      'commit enabled',
      10000
    )
    await click('[data-testid="git-commit"]')
    await waitForNotice('Committed', 20000)
    await setValueRetry('[data-testid="git-commit-message"]', 'Feature smoke amended')
    // The commit bar re-renders after the post-commit snapshot refresh; wait
    // for the refreshed control instead of racing the previous frame.
    await waitForSelector('[data-testid="git-commit-menu-button"]', 15000)
    await click('[data-testid="git-commit-menu-button"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="git-amend"]')) && !document.querySelector('[data-testid="git-amend"]').disabled`,
      'amend enabled',
      10000
    )
    await screenshot('06-commit-menu')
    await waitForSelector('[data-testid="git-amend"]', 10000)
    await click('[data-testid="git-amend"]')
    await waitForSelector('[data-testid="amend-dialog"]', 10000)
    await sleep(200)
    await screenshot('06-amend-confirm')
    await click('[data-testid="amend-confirm"]')
    await waitForNotice('Amended', 20000)
    return { sessionId, watcherLatencyMs }
  })

  await step('commit all tracked changes with sign-off from the SCM menu', async () => {
    await click('[data-testid="rail-settings"]')
    await waitForSelector('[data-testid="settings-view"]', 15000)
    await waitForSelector('[data-testid="scm-setting-always-signoff"]', 10000)
    await click('[data-testid="scm-setting-always-signoff"]')
    await waitFor(
      `document.querySelector('[data-testid="scm-setting-always-signoff"]')?.checked === true`,
      'sign-off setting enabled',
      5000
    )
    let stored = await cdp.evaluate(
      `(() => { try { return JSON.parse(window.localStorage.getItem('icode.scm.settings.v1') ?? 'null') } catch { return null } })()`
    )
    assert(stored?.alwaysSignOff === true, 'sign-off setting was not persisted')

    await click('[data-testid="rail-projects"]')
    await waitForSelector('[data-testid="projects-wall"]', 15000)
    await openSessionWorkspace()
    await click(`[data-testid="session-item-${sessionId}"]`)
    await waitForSelector('[data-testid="session-title"]', 20000)

    await cdp.evaluate(`(async () => {
      const result = await window.icode.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'README.md', text: 'signed commit by feature smoke\\n' });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    })()`)
    await openChanges()
    await waitForSelector('[data-testid="working-file-unstaged-README.md"]', 15000)
    await setValueRetry('[data-testid="git-commit-message"]', 'Sign-off smoke')
    await click('[data-testid="git-commit-menu-button"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="git-commit-all"]')) && !document.querySelector('[data-testid="git-commit-all"]').disabled`,
      'Commit all is enabled',
      10000
    )
    await screenshot('06b-commit-all-menu')
    await click('[data-testid="git-commit-all"]')
    await waitForNotice('Committed', 20000)

    const body = require('node:child_process').execFileSync(
      'git',
      ['-C', worktreePath, 'log', '-1', '--pretty=%B'],
      { encoding: 'utf8' }
    )
    assert(body.includes('Sign-off smoke'), 'the Commit all subject was not recorded')
    assert(
      body.includes('Signed-off-by: Feature Smoke <feature@smoke.test>'),
      `the sign-off trailer is missing: ${body}`
    )
    const status = require('node:child_process').execFileSync(
      'git',
      ['-C', worktreePath, 'status', '--porcelain'],
      { encoding: 'utf8' }
    )
    assert(status.trim() === '', `the worktree is not clean after Commit all: ${status}`)

    await click('[data-testid="rail-settings"]')
    await waitForSelector('[data-testid="scm-setting-always-signoff"]', 10000)
    await click('[data-testid="scm-setting-always-signoff"]')
    await waitFor(
      `document.querySelector('[data-testid="scm-setting-always-signoff"]')?.checked === false`,
      'sign-off setting restored',
      5000
    )
    stored = await cdp.evaluate(
      `(() => { try { return JSON.parse(window.localStorage.getItem('icode.scm.settings.v1') ?? 'null') } catch { return null } })()`
    )
    assert(stored?.alwaysSignOff === false, 'sign-off setting was not restored')
    return { signedOff: true }
  })

  await step('create, edit and delete a schedule through the drawer', async () => {
    await click('[data-testid="rail-schedules"]')
    await waitForSelector('[data-testid="schedules-view"]', 15000)
    await click('[data-testid="schedule-new"]')
    await waitForSelector('[data-testid="schedule-editor"]', 10000)
    await waitFor(
      `document.querySelectorAll('[data-testid="schedule-harness"] option').length > 0`,
      'schedule Harness options',
      20000
    )
    await setValueRetry('[data-testid="schedule-title"]', 'Smoke schedule')
    await setValueRetry('[data-testid="schedule-prompt"]', 'Check the smoke repository')
    await waitFor(
      `!document.querySelector('[data-testid="schedule-save"]').disabled`,
      'schedule save enabled',
      10000
    )
    await sleep(400)
    await screenshot('07-schedule-editor')
    await click('[data-testid="schedule-save"]')
    await waitForNotice('Scheduled Smoke schedule', 20000)
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid^="schedule-row-"]')).some((el) => el.innerText.includes('Smoke schedule'))`,
      'created schedule row',
      15000
    )
    const editId = await cdp.evaluate(
      `document.querySelector('[data-testid^="schedule-edit-"]')?.getAttribute('data-testid')?.replace('schedule-edit-', '') ?? null`
    )
    assert(editId, 'No schedule edit button')
    await click(`[data-testid="schedule-edit-${editId}"]`)
    await waitForSelector('[data-testid="schedule-editor"]', 10000)
    await waitFor(
      `document.querySelectorAll('[data-testid="schedule-harness"] option').length > 0 && !document.querySelector('[data-testid="schedule-save"]').disabled`,
      'edit form ready',
      20000
    )
    await setValueRetry('[data-testid="schedule-title"]', 'Smoke schedule edited')
    await click('[data-testid="schedule-save"]')
    await waitForNotice('Saved Smoke schedule edited', 20000)
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid^="schedule-row-"]')).some((el) => el.innerText.includes('Smoke schedule edited'))`,
      'edited schedule row',
      15000
    )
    await click(`[data-testid="schedule-edit-${editId}"]`)
    await waitForSelector('[data-testid="schedule-delete-ask"]', 10000)
    await click('[data-testid="schedule-delete-ask"]')
    await waitForSelector('[data-testid="schedule-delete-confirm"]', 10000)
    await screenshot('08-schedule-delete-confirm')
    await click('[data-testid="schedule-delete"]')
    await waitForNotice('Deleted Smoke schedule edited', 20000)
    await waitFor(
      `!document.querySelector('[data-testid^="schedule-row-"]')`,
      'schedule removed',
      10000
    )
  })

  await step('show Source Control defaults in Settings and persist a change', async () => {
    await click('[data-testid="rail-settings"]')
    await waitForSelector('[data-testid="settings-view"]', 15000)
    await waitForSelector('[data-testid="provider-select-claude"]', 10000)
    const providerCard = await cdp.evaluate(`(() => {
      const select = document.querySelector('[data-testid="provider-select-claude"]');
      return select?.closest('section')?.innerText ?? '';
    })()`)
    assert(providerCard.includes('Agent providers'), 'Settings omitted the Agent providers card')
    assert(providerCard.includes('Claude Code'), 'Provider card omitted Claude Code')
    await waitForSelector('[data-testid="scm-setting-smart-commit"]', 10000)
    const card = await cdp.evaluate(`(() => {
      const smart = document.querySelector('[data-testid="scm-setting-smart-commit"]');
      const section = smart?.closest('section');
      return {
        text: section?.innerText ?? '',
        smartCommit: smart?.value ?? null,
        untracked: document.querySelector('[data-testid="scm-setting-untracked"]')?.value ?? null,
        autoFetchPresent: Boolean(document.querySelector('input[aria-label="Auto-fetch"]')),
        autoRefresh: document.querySelector('input[aria-label="Auto-refresh"]')?.checked ?? null
      };
    })()`)
    assert(card.text.includes('Source Control'), 'Settings omitted the Source Control card')
    assert(card.text.includes('Smart commit'), 'Settings omitted the smart-commit field')
    assert(card.smartCommit === 'off', `smart commit default was ${String(card.smartCommit)}`)
    assert(card.untracked === 'separate', `untracked default was ${String(card.untracked)}`)
    assert(card.autoFetchPresent === false, 'auto-fetch setting must be removed')
    assert(card.autoRefresh === true, 'auto-refresh must default to on')
    await screenshot('09-settings-source-control')

    await setValue('[data-testid="scm-setting-smart-commit"]', 'tracked')
    await waitFor(
      `document.querySelector('[data-testid="scm-setting-smart-commit"]')?.value === 'tracked'`,
      'smart-commit setting change',
      5000
    )
    const stored = await cdp.evaluate(
      `(() => { try { return JSON.parse(window.localStorage.getItem('icode.scm.settings.v1') ?? 'null') } catch { return null } })()`
    )
    assert(stored?.smartCommit === 'tracked', 'smart-commit change was not persisted')
    await setValue('[data-testid="scm-setting-smart-commit"]', 'off')
    await waitFor(
      `document.querySelector('[data-testid="scm-setting-smart-commit"]')?.value === 'off'`,
      'smart-commit setting restored',
      5000
    )

    await click('[data-testid="rail-projects"]')
    await waitForSelector('[data-testid="projects-wall"]', 15000)
    return { smartCommit: card.smartCommit, untracked: card.untracked }
  })

  await step('keep TaskWorkbench panes and unsaved Files text across tab switches', async () => {
    await click('[data-testid="new-menu"]')
    await click('[data-testid="queue-task-from-menu"]')
    await waitForSelector('[data-testid="task-composer"]', 15000)
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="task-harness"] option')).some((option) => option.value === 'shell' && !option.disabled)`,
      'task Harness options',
      20000
    )
    await setValue('[data-testid="task-harness"]', 'shell')
    await setValue('[data-testid="task-prompt"]', 'Task continuity smoke')
    await click('[data-testid="task-create"]')
    await waitForSelector('[data-testid="task-workbench"]', 20000)
    await waitFor(
      `document.querySelector('[data-testid="task-tab-terminal"]') && !document.querySelector('[data-testid="task-tab-terminal"]').disabled`,
      'task session attached',
      30000
    )

    await click('[data-testid="task-tab-files"]')
    await waitForSelector('[data-testid="files-panel"]', 15000)
    await click('[data-testid="files-new-file"]')
    await setValue('[data-testid="files-pending-input"]', 'smoke-draft.txt')
    await click('[data-testid="files-pending-confirm"]')
    await waitForSelector('[data-testid="monaco-editor"]', 20000)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="monaco-editor"] .monaco-editor'))`,
      'task Monaco editor mounted',
      20000
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="monaco-editor"]')?.__icodeEditor?.focus()`
    )
    await cdp.send('Input.insertText', { text: 'unsaved task draft' })
    await waitForSelector('[data-testid="editor-dirty"]', 10000)
    await click('[data-testid="task-tab-overview"]')
    await sleep(300)
    await click('[data-testid="task-tab-files"]')
    await waitFor(
      `document.querySelector('[data-testid="monaco-editor"]')?.__icodeEditor?.getValue().includes('unsaved task draft') === true`,
      'unsaved Monaco text survives a tab switch',
      10000
    )

    await click('[data-testid="task-tab-terminal"]')
    await waitForSelector('[data-testid^="terminal-pane-"]', 15000)
    await click('[data-testid="task-tab-overview"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="task-terminal-view"] [data-testid^="terminal-pane-"]'))`,
      'terminal pane stays mounted while Overview is active',
      10000
    )
    await screenshot('10-task-continuity')

    await click('[data-testid="project-mode-sessions"]')
    await waitForSelector('[data-testid="project-sessions-list"]', 15000)
    await click('[data-testid="project-mode-tasks"]')
    await waitForSelector('[data-testid="task-workbench"]', 15000)
    await waitFor(
      `document.querySelector('[data-testid="task-workbench"] h1')?.innerText === 'Task continuity smoke'`,
      'the last task is restored after switching project modes',
      10000
    )

    // Phase A Files: session-scoped tabs, live external refresh, conflict-safe
    // save and the unsaved-change guards. This runs on the same direct session
    // whose worktree the earlier Git steps used.
    await click('[data-testid="project-mode-sessions"]')
    await waitForSelector('[data-testid="project-sessions-list"]', 15000)
    await click(`[data-testid="session-item-${sessionId}"]`)
    await waitForSelector('[data-testid="session-title"]', 20000)
    await click('[data-testid="view-files"]')
    await waitForSelector('[data-testid="files-panel"]', 15000)
    await waitFor(
      `document.querySelector('[data-testid="files-panel"]')?.dataset.liveMode === 'watch'`,
      'Files worktree watcher active',
      15000
    )

    await waitForSelector('[data-testid="files-entry-README.md"]', 15000)
    await click('[data-testid="files-entry-README.md"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="monaco-editor"]')?.__icodeEditor)`,
      'Files Monaco editor mounted',
      20000
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="monaco-editor"]')?.__icodeEditor?.focus()`
    )
    await cdp.send('Input.insertText', { text: 'phase-a dirty text\\n' })
    await waitForSelector('[data-testid="files-tab-dirty"]', 10000)
    const dirtyText = await cdp.evaluate(
      `document.querySelector('[data-testid="monaco-editor"]')?.__icodeEditor?.getValue() ?? ''`
    )
    assert(dirtyText.includes('phase-a dirty text'), 'typed Files text was not in the editor')

    // A second file opens a second tab; returning restores the first buffer.
    await waitForSelector('[data-testid="files-entry-watcher-live.txt"]', 15000)
    await click('[data-testid="files-entry-watcher-live.txt"]')
    await waitForSelector('[data-testid="files-tab-watcher-live.txt"]', 10000)
    await click('[data-testid="files-tab-README.md"]')
    await waitFor(
      `document.querySelector('[data-testid="monaco-editor"]')?.__icodeEditor?.getValue().includes('phase-a dirty text') === true`,
      'unsaved text survives a Files tab switch',
      10000
    )

    // An Agent write changes the version underneath a dirty buffer. It must be
    // marked, and Save must ask before overwriting.
    await cdp.evaluate(`(async () => {
      const result = await window.icode.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'README.md', text: 'external agent version\\n' });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    })()`)
    await waitForSelector('[data-testid="files-disk-changed"]', 15000)
    await click('[data-testid="editor-save"]')
    await waitForSelector('[data-testid="files-conflict-dialog"]', 15000)
    await click('[data-testid="files-conflict-overwrite"]')
    await waitFor(
      `!document.querySelector('[data-testid="files-conflict-dialog"]')`,
      'conflict dialog resolved',
      15000
    )
    const diskAfterOverwrite = await cdp.evaluate(`(async () => {
      const result = await window.icode.files.read({ sessionId: ${JSON.stringify(sessionId)}, path: 'README.md' });
      return result.ok && result.value.status === 'ok' ? result.value.text : '';
    })()`)
    assert(
      diskAfterOverwrite.includes('phase-a dirty text'),
      'Overwrite did not write the user buffer to disk'
    )

    // Closing a dirty tab asks; Cancel keeps both the tab and the text.
    await cdp.evaluate(
      `document.querySelector('[data-testid="monaco-editor"]')?.__icodeEditor?.focus()`
    )
    await cdp.send('Input.insertText', { text: 'still-dirty-text\\n' })
    await waitForSelector('[data-testid="files-tab-dirty"]', 10000)
    await click('[data-testid="files-tab-close-README.md"]')
    await waitForSelector('[data-testid="files-unsaved-dialog"]', 10000)
    await click('[data-testid="files-unsaved-cancel"]')
    await waitFor(
      `!document.querySelector('[data-testid="files-unsaved-dialog"]') && Boolean(document.querySelector('[data-testid="files-tab-README.md"]'))`,
      'Cancel kept the dirty tab',
      10000
    )

    // Removing the session names the unsaved Files text before it can be lost.
    await click('[data-testid="session-menu"]')
    await waitForSelector('[data-testid="remove-session"]', 10000)
    await click('[data-testid="remove-session"]')
    await waitForSelector('[data-testid="remove-session-dialog"]', 10000)
    assert(
      await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="remove-session-unsaved"]'))`
      ),
      'Remove session did not warn about unsaved Files text'
    )
    await click('[data-testid="remove-session-cancel"]')
    await waitFor(
      `!document.querySelector('[data-testid="remove-session-dialog"]')`,
      'remove-session cancel dismissed the dialog',
      10000
    )

    // The window close handshake asks once and Cancel leaves the app open.
    await cdp.evaluate('window.icode.window.close()')
    await waitForSelector('[data-testid="files-app-close-dialog"]', 15000)
    await click('[data-testid="files-app-close-cancel"]')
    await waitFor(
      `!document.querySelector('[data-testid="files-app-close-dialog"]')`,
      'app-close cancel dismissed the prompt',
      10000
    )
    await sleep(300)
    await cdp.evaluate('document.title')
    await screenshot('11-files-tabs-conflict')

    // Close All → Save All writes the dirty buffer and closes every tab.
    await click('[data-testid="files-close-all"]')
    await waitForSelector('[data-testid="files-unsaved-dialog"]', 10000)
    await click('[data-testid="files-unsaved-save"]')
    await waitFor(
      `!document.querySelector('[data-testid="files-tab-README.md"]') && !document.querySelector('[data-testid="files-tab-watcher-live.txt"]')`,
      'Close All saved and closed every tab',
      15000
    )
    const diskAfterCloseAll = await cdp.evaluate(`(async () => {
      const result = await window.icode.files.read({ sessionId: ${JSON.stringify(sessionId)}, path: 'README.md' });
      return result.ok && result.value.status === 'ok' ? result.value.text : '';
    })()`)
    assert(
      diskAfterCloseAll.includes('still-dirty-text'),
      'Save All from Close All did not write the dirty buffer'
    )

    await click('[data-testid="theme-menu-button"]')
    await waitForSelector('[data-testid="theme-menu"]', 10000)
    await click('[data-testid="theme-option-dark"]')
    await sleep(250)
    await ctrlK()
    await waitForSelector('[data-testid="command-palette"]', 10000)
    await sleep(200)
    await screenshot('10-dark-command-palette')
    await key('[data-testid="command-palette-input"]', 'Escape')
  })

  await step('Files explorer: selection, context menu, inline rename, clipboard, batch delete and drag & drop', async () => {
    if (!(await cdp.evaluate(`Boolean(document.querySelector('[data-testid="files-panel"]'))`))) {
      await openSessionWorkspace()
      await click(`[data-testid="session-item-${sessionId}"]`)
      await waitForSelector('[data-testid="session-title"]', 20000)
      await click('[data-testid="view-files"]')
    }
    await waitForSelector('[data-testid="files-panel"]', 15000)

    await cdp.evaluate(`(async () => {
      const sessionId = ${JSON.stringify(sessionId)};
      const create = async (path, kind) => {
        const result = await window.icode.files.create({ sessionId, path, kind });
        if (!result.ok) throw new Error(result.error.message);
        if (result.value.status === 'unavailable') throw new Error(result.value.detail);
      };
      await create('phase-b', 'directory');
      for (const path of [
        'phase-b/one.txt',
        'phase-b/two.txt',
        'phase-b/drag.txt',
        'phase-b/del1.txt',
        'phase-b/del2.txt'
      ]) {
        await create(path, 'file');
      }
      await create('phase-b/copy-target', 'directory');
      await create('phase-b/drop-target', 'directory');
      return true;
    })()`)

    await click('[data-testid="files-refresh"]')
    await waitForSelector('[data-testid="files-entry-phase-b"]', 20000)
    const expanded = await cdp.evaluate(
      `document.querySelector('[data-testid="files-entry-phase-b"]')?.getAttribute('aria-expanded') === 'true'`
    )
    if (!expanded) await click('[data-testid="files-entry-phase-b"]')
    await waitForSelector('[data-testid="files-entry-phase-b/one.txt"]', 20000)

    await click('[data-testid="files-entry-phase-b/one.txt"]')
    await clickWithModifiers('[data-testid="files-entry-phase-b/two.txt"]', { ctrlKey: true })
    await waitFor(
      `document.querySelector('[data-testid="files-selection"]')?.innerText.includes('2 selected') === true`,
      'Files multi-selection summary',
      10000
    )

    await rightClick('[data-testid="files-entry-phase-b/one.txt"]')
    await waitForSelector('[data-testid="files-context-menu"]', 10000)
    await waitForSelector('[data-testid="files-menu-copy"]', 5000)
    await screenshot('12-files-context-menu')
    await click('[data-testid="files-menu-copy"]')

    await rightClick('[data-testid="files-entry-phase-b/copy-target"]', 360, 420)
    await waitForSelector('[data-testid="files-context-menu"]', 10000)
    await click('[data-testid="files-menu-paste"]')
    await waitFor(
      `(async () => {
        const result = await window.icode.files.read({ sessionId: ${JSON.stringify(sessionId)}, path: 'phase-b/copy-target/one.txt' });
        return result.ok && result.value.status === 'ok';
      })()`,
      'pasted copy exists',
      15000
    )
    await waitFor(
      `document.querySelector('[data-testid="files-panel"]')?.dataset.busy === 'false'`,
      'paste settled',
      10000
    )

    log('phase-b: inline rename')
    await click('[data-testid="files-entry-phase-b/two.txt"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="files-rename"]')) && document.querySelector('[data-testid="files-rename"]').disabled === false`,
      'rename action enabled',
      10000
    )
    await click('[data-testid="files-rename"]')
    try {
      await waitForSelector('[data-testid="files-pending-input"]', 2500)
    } catch {
      const state = await cdp.evaluate(`(() => ({
        selection: document.querySelector('[data-testid="files-selection"]')?.innerText ?? '',
        pending: Boolean(document.querySelector('[data-testid="files-pending-input"]')),
        active: document.activeElement?.getAttribute('data-testid') ?? '',
        focusedRow: document.querySelector('[data-testid="files-entry-phase-b/two.txt"]') ? 'row' : 'missing'
      }))()`)
      log(`phase-b: inline rename retry after ${JSON.stringify(state)}`)
      await click('[data-testid="files-rename"]')
    }
    await waitForSelector('[data-testid="files-pending-input"]', 10000)
    await setValue('[data-testid="files-pending-input"]', 'renamed.txt')
    await click('[data-testid="files-pending-confirm"]')
    await waitFor(
      `(async () => {
        const result = await window.icode.files.read({ sessionId: ${JSON.stringify(sessionId)}, path: 'phase-b/renamed.txt' });
        return result.ok && result.value.status === 'ok';
      })()`,
      'inline rename reached disk',
      15000
    )
    await waitForSelector('[data-testid="files-entry-phase-b/renamed.txt"]', 15000)

    log('phase-b: copy relative path')
    await rightClick('[data-testid="files-entry-phase-b/renamed.txt"]', 340, 440)
    await waitForSelector('[data-testid="files-context-menu"]', 10000)
    await click('[data-testid="files-menu-copy-relative-path"]')
    const clipboardText = await cdp.evaluate(`(async () => {
      try { return await navigator.clipboard.readText(); }
      catch (error) { return 'unavailable:' + error.message; }
    })()`)
    if (String(clipboardText).startsWith('unavailable:')) {
      log('phase-b: system clipboard read unavailable; checking the notice instead')
      await waitFor(
        `document.body.innerText.includes('Copied 1 path')`,
        'copy-relative-path notice',
        10000
      )
    } else {
      assert(clipboardText === 'phase-b/renamed.txt', 'Copy Relative Path used the wrong text')
      log('phase-b: system clipboard verified')
    }

    log('phase-b: batch delete')
    await click('[data-testid="files-entry-phase-b/del1.txt"]')
    await clickWithModifiers('[data-testid="files-entry-phase-b/del2.txt"]', { ctrlKey: true })
    await waitFor(
      `document.querySelector('[data-testid="files-selection"]')?.innerText.includes('2 selected') === true`,
      'delete multi-selection',
      10000
    )
    await click('[data-testid="files-delete"]')
    await waitForSelector('[data-testid="files-delete-dialog"]', 10000)
    await click('[data-testid="files-delete-confirm"]')
    await waitFor(
      `(async () => {
        const result = await window.icode.files.read({ sessionId: ${JSON.stringify(sessionId)}, path: 'phase-b/del1.txt' });
        return result.ok && result.value.status === 'unavailable' && result.value.reason === 'not-found';
      })()`,
      'batch delete removed the files',
      15000
    )
    await waitFor(
      `document.querySelector('[data-testid="files-panel"]')?.dataset.busy === 'false'`,
      'delete settled',
      10000
    )

    log('phase-b: keyboard')
    await click('[data-testid="files-entry-phase-b/renamed.txt"]')
    await focusElement('[data-testid="files-entry-phase-b/renamed.txt"]')
    await key('[data-testid="files-entry-phase-b/renamed.txt"]', 'F2')
    await waitForSelector('[data-testid="files-pending-input"]', 10000)
    await key('[data-testid="files-pending-input"]', 'Escape')
    await waitFor(
      `!document.querySelector('[data-testid="files-pending-input"]')`,
      'F2/Escape closed the inline editor',
      10000
    )
    await focusElement('[data-testid="files-entry-phase-b/renamed.txt"]')
    const beforeFocus = await cdp.evaluate(
      `document.activeElement?.getAttribute('data-testid') ?? ''`
    )
    await key('[data-testid="files-entry-phase-b/renamed.txt"]', 'ArrowDown')
    await sleep(150)
    const afterFocus = await cdp.evaluate(
      `document.activeElement?.getAttribute('data-testid') ?? ''`
    )
    assert(
      beforeFocus !== afterFocus && afterFocus.startsWith('files-entry-'),
      'ArrowDown did not move tree focus'
    )

    log('phase-b: drag & drop')
    await dragAndDrop(
      '[data-testid="files-entry-phase-b/drag.txt"]',
      '[data-testid="files-entry-phase-b/drop-target"]'
    )
    await waitForSelector('[data-testid="files-move-dialog"]', 10000)
    await click('[data-testid="files-move-confirm"]')
    await waitFor(
      `(async () => {
        const result = await window.icode.files.read({ sessionId: ${JSON.stringify(sessionId)}, path: 'phase-b/drop-target/drag.txt' });
        return result.ok && result.value.status === 'ok';
      })()`,
      'drag & drop moved the file',
      15000
    )
    await waitFor(
      `document.querySelector('[data-testid="files-panel"]')?.dataset.busy === 'false'`,
      'drag move settled',
      10000
    )

    // Cut → paste into a folder moves through the clipboard path.
    log('phase-b: cut/paste')
    await cdp.evaluate(`(async () => {
      const result = await window.icode.files.create({ sessionId: ${JSON.stringify(sessionId)}, path: 'phase-b/cut.txt', kind: 'file' });
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.status === 'unavailable') throw new Error(result.value.detail);
      return true;
    })()`)
    await click('[data-testid="files-refresh"]')
    await waitForSelector('[data-testid="files-entry-phase-b/cut.txt"]', 15000)
    await rightClick('[data-testid="files-entry-phase-b/cut.txt"]', 350, 500)
    await waitForSelector('[data-testid="files-context-menu"]', 10000)
    await click('[data-testid="files-menu-cut"]')
    await rightClick('[data-testid="files-entry-phase-b/copy-target"]', 360, 420)
    await waitForSelector('[data-testid="files-context-menu"]', 10000)
    await click('[data-testid="files-menu-paste"]')
    await waitFor(
      `(async () => {
        const result = await window.icode.files.read({ sessionId: ${JSON.stringify(sessionId)}, path: 'phase-b/copy-target/cut.txt' });
        return result.ok && result.value.status === 'ok';
      })()`,
      'cut/paste moved the file',
      15000
    )
    await waitFor(
      `(async () => {
        const result = await window.icode.files.read({ sessionId: ${JSON.stringify(sessionId)}, path: 'phase-b/cut.txt' });
        return result.ok && result.value.status === 'unavailable' && result.value.reason === 'not-found';
      })()`,
      'cut source no longer exists',
      15000
    )
    await waitFor(
      `document.querySelector('[data-testid="files-panel"]')?.dataset.busy === 'false'`,
      'cut paste settled',
      10000
    )
    await screenshot('12-files-explorer')
  })

  await step('Files phase C: Git marks, visibility rules, compact/nesting, search and replace', async () => {
    if (!(await cdp.evaluate(`Boolean(document.querySelector('[data-testid="files-panel"]'))`))) {
      await click(`[data-testid="session-item-${sessionId}"]`)
      await waitForSelector('[data-testid="session-title"]', 20000)
      await click('[data-testid="view-files"]')
    }
    await waitForSelector('[data-testid="files-panel"]', 15000)

    await cdp.evaluate(`(async () => {
      const sessionId = ${JSON.stringify(sessionId)};
      const create = async (path, kind) => {
        const result = await window.icode.files.create({ sessionId, path, kind });
        if (!result.ok) throw new Error(result.error.message);
        if (result.value.status === 'unavailable' && result.value.reason !== 'already-exists') {
          throw new Error(result.value.detail);
        }
      };
      const write = async (path, text) => {
        const result = await window.icode.files.write({ sessionId, path, text });
        if (!result.ok) throw new Error(result.error.message);
        if (result.value.status === 'unavailable') throw new Error(result.value.detail);
      };
      await create('phase-c', 'directory');
      await create('phase-c/compact', 'directory');
      await create('phase-c/compact/inner', 'directory');
      await write('phase-c/alpha.ts', 'const needle = 1\\nneedle needle\\n');
      await write('phase-c/alpha.test.ts', 'needle in test\\n');
      await write('phase-c/compact/inner/deep.ts', 'needle deep\\n');
      await write('phase-c/hide.log', 'needle hidden by exclude\\n');
      await write('phase-c/skip.ignored', 'needle ignored by git\\n');
      await write('.gitignore', '*.ignored\\n');
      return true;
    })()`)

    await click('[data-testid="files-refresh"]')
    await waitForSelector('[data-testid="files-entry-phase-c"]', 20000)
    if (
      !(await cdp.evaluate(
        `document.querySelector('[data-testid="files-entry-phase-c"]')?.getAttribute('aria-expanded') === 'true'`
      ))
    ) {
      await click('[data-testid="files-entry-phase-c"]')
    }
    await waitForSelector('[data-testid="files-entry-phase-c/alpha.ts"]', 15000)

    log('phase-c: Git decorations')
    await waitForSelector('[data-testid="files-decoration-phase-c/alpha.ts"]', 20000)
    const letters = await cdp.evaluate(`(() => ({
      file: document.querySelector('[data-testid="files-decoration-phase-c/alpha.ts"]')?.textContent ?? '',
      folder: Boolean(document.querySelector('[data-testid="files-folder-decorated-phase-c"]'))
    }))()`)
    assert(letters.file === 'U', `untracked decoration was ${letters.file}`)
    assert(letters.folder, 'a folder with a dirty descendant had no dot')

    log('phase-c: compact folders (default on) and nesting (default off)')
    await waitForSelector('[data-testid="files-entry-phase-c/compact/inner"]', 15000)
    const compactLabel = await cdp.evaluate(
      `document.querySelector('[data-testid="files-entry-phase-c/compact/inner"]')?.innerText ?? ''`
    )
    assert(compactLabel.includes('compact/inner'), 'compact folders did not join the chain')
    await click('[data-testid="files-entry-phase-c/compact/inner"]')
    await waitForSelector('[data-testid="files-entry-phase-c/compact/inner/deep.ts"]', 15000)
    assert(
      await cdp.evaluate(
        `document.querySelector('[data-testid="files-entry-phase-c/alpha.test.ts"]')?.getAttribute('data-nested') === null`
      ),
      'file nesting was on by default'
    )

    log('phase-c: grouped search, invalid regex and literal replace')
    await setValue('[data-testid="files-search-input"]', 'needle')
    await key('[data-testid="files-search-input"]', 'Enter')
    await waitForSelector('[data-testid="files-search-file-phase-c/alpha.ts"]', 20000)
    assert(
      await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="files-search-hit-phase-c/alpha.ts-1"]'))`
      ),
      'grouped search did not show per-line hits'
    )

    await click('[data-testid="files-search-regex"]')
    await setValue('[data-testid="files-search-input"]', '(')
    await key('[data-testid="files-search-input"]', 'Enter')
    await waitForSelector('[data-testid="files-search-error"]', 10000)
    assert(
      await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="files-search-file-phase-c/alpha.ts"]'))`
      ),
      'an invalid regex erased the previous results'
    )
    await click('[data-testid="files-search-regex"]')
    await setValue('[data-testid="files-search-input"]', 'needle')
    await key('[data-testid="files-search-input"]', 'Enter')
    await waitForSelector('[data-testid="files-search-file-phase-c/alpha.ts"]', 20000)
    await waitFor(
      `(() => {
        const button = document.querySelector('[data-testid="files-replace-run"]');
        return Boolean(button) && button.disabled === false;
      })()`,
      'search finished and Replace all enabled',
      20000
    )
    await setValue('[data-testid="files-replace-input"]', 'pin')
    await click('[data-testid="files-replace-run"]')
    await waitForSelector('[data-testid="files-replace-dialog"]', 10000)
    const replaceText = await cdp.evaluate(
      `document.querySelector('[data-testid="files-replace-dialog"]')?.innerText ?? ''`
    )
    assert(replaceText.includes('phase-c/alpha.ts'), 'replace confirmation did not list files')
    await click('[data-testid="files-replace-confirm"]')
    await waitForNotice('Replaced', 20000)
    await waitFor(
      `(async () => {
        const result = await window.icode.files.read({ sessionId: ${JSON.stringify(sessionId)}, path: 'phase-c/alpha.ts' });
        return result.ok && result.value.status === 'ok' &&
          result.value.text.includes('const pin = 1') && !result.value.text.includes('needle');
      })()`,
      'literal replace wrote the new text',
      20000
    )
    await screenshot('13-files-search-replace')
    await click('[data-testid="files-search-clear"]')

    log('phase-c: apply settings, excludes, .gitignore, sort and nesting')
    await click('[data-testid="rail-settings"]')
    await waitForSelector('[data-testid="files-setting-exclude"]', 15000)
    await setValue(
      '[data-testid="files-setting-exclude"]',
      '.DS_Store\nThumbs.db\n*.log\n'
    )
    await click('[data-testid="files-setting-compact"]')
    await click('[data-testid="files-setting-nesting"]')
    await click('[data-testid="files-setting-gitignore"]')
    await setValue('[data-testid="files-setting-sort-order"]', 'modified')
    await setValue('[data-testid="files-setting-sort-direction"]', 'desc')
    await waitFor(
      `(() => { try {
        const value = JSON.parse(window.localStorage.getItem('icode.files.settings.v1') ?? 'null');
        return value && value.exclude?.includes('*.log') && value.compactFolders === false &&
          value.fileNesting === true && value.excludeGitIgnore === true &&
          value.sortOrder === 'modified' && value.sortDirection === 'desc';
      } catch { return false } })()`,
      'Files settings persisted',
      10000
    )

    await click('[data-testid="rail-projects"]')
    await waitForSelector('[data-testid="projects-wall"]', 20000)
    await openSessionWorkspace()
    await click(`[data-testid="session-item-${sessionId}"]`)
    await waitForSelector('[data-testid="session-title"]', 20000)
    await click('[data-testid="view-files"]')
    await waitForSelector('[data-testid="files-panel"]', 15000)
    await waitForSelector('[data-testid="files-entry-phase-c"]', 20000)
    if (
      !(await cdp.evaluate(
        `document.querySelector('[data-testid="files-entry-phase-c"]')?.getAttribute('aria-expanded') === 'true'`
      ))
    ) {
      await click('[data-testid="files-entry-phase-c"]')
    }
    await waitForSelector('[data-testid="files-entry-phase-c/alpha.ts"]', 20000)
    await waitFor(
      `!document.querySelector('[data-testid="files-entry-phase-c/hide.log"]')`,
      'exclude pattern hid the log file',
      20000
    )
    await waitFor(
      `!document.querySelector('[data-testid="files-entry-phase-c/skip.ignored"]')`,
      '.gitignore hid the ignored file',
      20000
    )
    assert(
      await cdp.evaluate(
        `document.querySelector('[data-testid="files-entry-phase-c/alpha.test.ts"]')?.getAttribute('data-nested') === 'true'`
      ),
      'file nesting did not group the test beside its source'
    )
    await waitForSelector('[data-testid="files-entry-phase-c/compact"]', 15000)
    await click('[data-testid="files-entry-phase-c/compact"]')
    await waitForSelector('[data-testid="files-entry-phase-c/compact/inner"]', 15000)
    await screenshot('13-files-phase-c')

    log('phase-c: auto-reveal after returning to Files')
    await click('[data-testid="files-entry-phase-c/alpha.ts"]')
    await waitForSelector('[data-testid="files-tab-phase-c/alpha.ts"]', 15000)
    if (
      await cdp.evaluate(
        `document.querySelector('[data-testid="files-entry-phase-c"]')?.getAttribute('aria-expanded') === 'true'`
      )
    ) {
      await click('[data-testid="files-entry-phase-c"]')
    }
    await waitFor(
      `!document.querySelector('[data-testid="files-entry-phase-c/alpha.ts"]')`,
      'the collapsed folder hid the active file',
      10000
    )
    await click('[data-testid="view-changes"]')
    await sleep(300)
    await click('[data-testid="view-files"]')
    await waitForSelector('[data-testid="files-entry-phase-c/alpha.ts"]', 20000)
    await waitFor(
      `document.querySelector('[data-testid="files-selection"]')?.innerText.includes('phase-c/alpha.ts') === true`,
      'auto-reveal focused the active file row',
      15000
    )
  })

  await step('Files phase D: trash undo, duplicate, hot exit, persisted tree and virtualized rows', async () => {
    await cdp.evaluate(`(async () => {
      const sessionId = ${JSON.stringify(sessionId)};
      const create = async (path, kind) => {
        const result = await window.icode.files.create({ sessionId, path, kind });
        if (!result.ok) throw new Error(result.error.message);
        if (result.value.status === 'unavailable' && result.value.reason !== 'already-exists') {
          throw new Error(result.value.detail);
        }
      };
      const write = async (path, text) => {
        const result = await window.icode.files.write({ sessionId, path, text });
        if (!result.ok) throw new Error(result.error.message);
        if (result.value.status === 'unavailable') throw new Error(result.value.detail);
      };
      await create('phase-d', 'directory');
      await create('phase-d/large', 'directory');
      await write('phase-d/trash.txt', 'restore me\\n');
      await write('phase-d/dup.txt', 'duplicate me\\n');
      return true;
    })()`)
    // A real large folder; empty files keep the fixture cheap on disk.
    for (let index = 0; index < 1000; index += 1) {
      writeFileSync(join(worktreePath, 'phase-d', 'large', `file-${String(index)}.txt`), '')
    }
    await click('[data-testid="files-refresh"]')
    await waitForSelector('[data-testid="files-entry-phase-d"]', 20000)
    if (
      !(await cdp.evaluate(
        `document.querySelector('[data-testid="files-entry-phase-d"]')?.getAttribute('aria-expanded') === 'true'`
      ))
    ) {
      await click('[data-testid="files-entry-phase-d"]')
    }
    await waitForSelector('[data-testid="files-entry-phase-d/trash.txt"]', 20000)

    log('phase-d: delete to Trash and Undo')
    await click('[data-testid="files-entry-phase-d/trash.txt"]')
    await click('[data-testid="files-delete"]')
    await waitForSelector('[data-testid="files-delete-dialog"]', 10000)
    const deleteText = await cdp.evaluate(
      `document.querySelector('[data-testid="files-delete-dialog"]')?.innerText ?? ''`
    )
    assert(deleteText.includes('Trash'), 'the delete dialog did not offer Trash')
    await click('[data-testid="files-delete-confirm"]')
    await waitForNotice('Moved 1 item to Trash', 20000)
    await waitFor(
      `(async () => {
        const result = await window.icode.files.read({ sessionId: ${JSON.stringify(sessionId)}, path: 'phase-d/trash.txt' });
        return result.ok && result.value.status === 'unavailable' && result.value.reason === 'not-found';
      })()`,
      'the deleted path left the worktree',
      15000
    )
    await click('[data-testid="notice-action"]')
    await waitForNotice('Restored 1 item', 20000)
    await waitFor(
      `(async () => {
        const result = await window.icode.files.read({ sessionId: ${JSON.stringify(sessionId)}, path: 'phase-d/trash.txt' });
        return result.ok && result.value.status === 'ok' && result.value.text === 'restore me\\n';
      })()`,
      'Undo restored the deleted file',
      15000
    )

    log('phase-d: duplicate and undo')
    await click('[data-testid="files-entry-phase-d/dup.txt"]')
    await click('[data-testid="files-duplicate"]')
    await waitForSelector('[data-testid="files-entry-phase-d/dup copy.txt"]', 20000)
    await waitFor(
      `document.querySelector('[data-testid="files-undo"]')?.disabled === false`,
      'Duplicate became undoable',
      10000
    )
    await click('[data-testid="files-undo"]')
    await waitFor(
      `!document.querySelector('[data-testid="files-entry-phase-d/dup copy.txt"]')`,
      'Undo removed the duplicate',
      15000
    )

    log('phase-d: dirty tab survives a renderer reload')
    await click('[data-testid="files-entry-phase-d/dup.txt"]')
    await waitForSelector('[data-testid="monaco-editor"]', 20000)
    await cdp.evaluate(
      `document.querySelector('[data-testid="monaco-editor"]')?.__icodeEditor?.focus()`
    )
    await cdp.send('Input.insertText', { text: 'phase-d dirty text\\n' })
    await waitForSelector('[data-testid="files-tab-dirty"]', 10000)
    await sleep(800)
    await cdp.evaluate('location.reload()')
    await sleep(1200)
    await waitForSelector('[data-testid="app-rail"]', 30000)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="projects-wall"]')) || Boolean(document.querySelector('[data-testid="empty-workspace"]')) || Boolean(document.querySelector('[data-testid="project-sessions-list"]'))`,
      'workspace after reload',
      30000
    )
    await openSessionWorkspace()
    await click(`[data-testid="session-item-${sessionId}"]`)
    await waitForSelector('[data-testid="session-title"]', 20000)
    await click('[data-testid="view-files"]')
    await waitForSelector('[data-testid="files-panel"]', 15000)
    await waitForSelector('[data-testid="files-tab-phase-d/dup.txt"]', 20000)
    await waitFor(
      `document.querySelector('[data-testid="monaco-editor"]')?.__icodeEditor?.getValue().includes('phase-d dirty text') === true`,
      'hot-exit dirty text restored',
      20000
    )
    await waitForSelector('[data-testid="files-entry-phase-d/trash.txt"]', 20000)
    assert(
      await cdp.evaluate(
        `document.querySelector('[data-testid="files-entry-phase-d"]')?.getAttribute('aria-expanded') === 'true'`
      ),
      'expanded folders were not restored'
    )
    await waitForSelector('[data-testid="files-entry-phase-c/alpha.ts"]', 15000)
    assert(
      await cdp.evaluate(
        `document.querySelector('[data-testid="files-entry-phase-c"]')?.getAttribute('aria-expanded') === 'true'`
      ),
      'a folder outside the active tab was not restored'
    )
    await click('[data-testid="files-tab-close-phase-d/dup.txt"]')
    await waitForSelector('[data-testid="files-unsaved-dialog"]', 10000)
    await click('[data-testid="files-unsaved-discard"]')

    log('phase-d: virtualized large folder')
    await waitForSelector('[data-testid="files-entry-phase-d/large"]', 15000)
    await click('[data-testid="files-entry-phase-d/large"]')
    await cdp.evaluate(
      `document.querySelector('[data-testid="files-entry-phase-d/large"]')?.scrollIntoView({ block: 'start' })`
    )
    await waitForSelector('[data-testid^="files-entry-phase-d/large/file-"]', 20000)
    const mountedTop = await cdp.evaluate(
      `document.querySelectorAll('[data-testid^="files-entry-phase-d/large/file-"]').length`
    )
    assert(mountedTop < 100, `the large folder mounted ${String(mountedTop)} rows at the top`)
    await cdp.evaluate(`(() => {
      const element = document.querySelector('[data-testid="files-tree"]');
      if (!element) return false;
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()`)
    await waitFor(
      `document.querySelector('[data-testid="files-tree"]')?.scrollTop > 0`,
      'the large folder scrolled',
      10000
    )
    await sleep(250)
    const mountedBottom = await cdp.evaluate(
      `document.querySelectorAll('[data-testid^="files-entry-phase-d/large/file-"]').length`
    )
    assert(mountedBottom < 100, `the large folder mounted ${String(mountedBottom)} rows at the bottom`)
    assert(
      mountedBottom > 0,
      'the large folder rendered no rows after scrolling to the end'
    )
    await screenshot('14-files-phase-d')
  })

  await quit()
  RUN.finishedAt = new Date().toISOString()
  RUN.status = RUN.failures.length === 0 ? 'passed' : 'failed'
  writeFileSync(join(ARTIFACT_DIR, 'feature-smoke.json'), JSON.stringify(RUN, null, 2))
  log(`evidence: ${join(ARTIFACT_DIR, 'feature-smoke.json')}`)
  log(`status: ${RUN.status}`)
  if (RUN.status !== 'passed') process.exitCode = 1
}

run().catch(async (error) => {
  RUN.failures.push(error instanceof Error ? error.message : String(error))
  RUN.finishedAt = new Date().toISOString()
  RUN.status = 'failed'
  try {
    await quit()
  } catch {}
  writeFileSync(join(ARTIFACT_DIR, 'feature-smoke.json'), JSON.stringify(RUN, null, 2))
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
  log(`evidence: ${join(ARTIFACT_DIR, 'feature-smoke.json')}`)
  process.exitCode = 1
})
