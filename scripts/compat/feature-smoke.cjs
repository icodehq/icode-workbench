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
const RUN_DIR = mkdtempSync(join(tmpdir(), 'ade-feature-smoke-'))
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
      ADE_GATE_USER_DATA: USER_DATA,
      ADE_BACKGROUND_LAUNCH: '0'
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

  await step('exercise branch create, fetch, publish, history and compare in the header', async () => {
    await click('[data-testid="git-branch-chip"]')
    await waitForSelector('[data-testid="git-branch-menu"]', 10000)
    await screenshot('03b-branch-menu')
    for (const id of ['git-create-branch', 'git-fetch', 'git-publish', 'git-history', 'git-compare']) {
      assert(
        await cdp.evaluate(`Boolean(document.querySelector('[data-testid="${id}"]'))`),
        `Branch menu is missing ${id}`
      )
    }

    await click('[data-testid="git-create-branch"]')
    await setValue('[data-testid="git-new-branch-input"]', 'review/smoke')
    await click('[data-testid="git-new-branch-create"]')
    await waitForNotice('Created review/smoke', 20000)
    await waitFor(
      `document.querySelector('[data-testid="git-fetch"]') && !document.querySelector('[data-testid="git-fetch"]').disabled`,
      'fetch enabled after branch creation',
      10000
    )

    await click('[data-testid="git-fetch"]')
    await waitForNotice('Fetched origin', 30000)
    await waitFor(
      `document.querySelector('[data-testid="git-publish"]') && !document.querySelector('[data-testid="git-publish"]').disabled`,
      'publish enabled after fetch',
      10000
    )

    await click('[data-testid="git-publish"]')
    await waitForNotice('Published', 30000)
    await waitFor(
      `document.querySelector('[data-testid="git-history"]') && !document.querySelector('[data-testid="git-history"]').disabled`,
      'history enabled after publish',
      10000
    )

    await click('[data-testid="git-history"]')
    await waitForSelector('[data-testid="git-history-dialog"]', 20000)
    const historyText = await cdp.evaluate(`document.querySelector('[data-testid="git-history-dialog"]').innerText`)
    assert(historyText.includes('baseline'), 'History dialog omitted the initial commit')
    await sleep(200)
    await screenshot('04-git-history')
    await click('[aria-label="Close commit history"]')
    await click('[data-testid="git-branch-chip"]')
    await waitForSelector('[data-testid="git-branch-menu"]', 10000)

    await click('[data-testid="git-compare"]')
    await waitForSelector('[data-testid="git-compare-dialog"]', 20000)
    await sleep(200)
    await screenshot('05-git-compare')
    await click('[aria-label="Close comparison"]')

    if (!(await cdp.evaluate(`Boolean(document.querySelector('[data-testid="git-branch-menu"]'))`))) {
      await click('[data-testid="git-branch-chip"]')
      await waitForSelector('[data-testid="git-branch-menu"]', 10000)
    }
    await click('[data-testid="git-branch-manage"] summary')
    await waitFor(
      `document.querySelector('[data-testid="git-branch-manage"]')?.open === true`,
      'branch management open',
      5000
    )
    await setValue('[data-testid="git-branch-rename-from"]', 'review/smoke')
    await setValue('[data-testid="git-branch-rename-to"]', 'review/smoke-renamed')
    await click('[data-testid="git-branch-rename"]')
    await waitForNotice('Renamed review/smoke to review/smoke-renamed', 20000)

    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="git-branch-merge-target"] option')).some((option) => option.value === 'main')`,
      'merge target options',
      10000
    )
    await setValue('[data-testid="git-branch-merge-target"]', 'main')
    await click('[data-testid="git-branch-merge"]')
    await waitForNotice('Merged main', 20000)

    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="git-branch-rebase-target"] option')).some((option) => option.value === 'main')`,
      'rebase target options',
      10000
    )
    await setValue('[data-testid="git-branch-rebase-target"]', 'main')
    await click('[data-testid="git-branch-rebase"]')
    await waitForSelector('[data-testid="git-branch-rebase-confirm"]', 5000)
    await click('[data-testid="git-branch-rebase-confirm"]')
    await waitForNotice('Rebased onto main', 20000)

    await click('[data-testid="git-create-branch"]')
    await setValue('[data-testid="git-new-branch-input"]', 'review/delete-me')
    await click('[data-testid="git-new-branch-create"]')
    await waitForNotice('Created review/delete-me', 20000)
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="git-branch-delete-target"] option')).some((option) => option.value === 'review/delete-me')`,
      'delete target options',
      10000
    )
    await setValue('[data-testid="git-branch-delete-target"]', 'review/delete-me')
    await click('[data-testid="git-branch-delete"]')
    await waitForNotice('Deleted branch review/delete-me', 20000)
    if (!(await cdp.evaluate(`Boolean(document.querySelector('[data-testid="git-branch-menu"]'))`))) {
      await click('[data-testid="git-branch-chip"]')
      await waitForSelector('[data-testid="git-branch-menu"]', 10000)
    }
    if (
      !(await cdp.evaluate(
        `document.querySelector('[data-testid="git-branch-manage"]')?.open === true`
      ))
    ) {
      await click('[data-testid="git-branch-manage"] summary')
      await waitFor(
        `document.querySelector('[data-testid="git-branch-manage"]')?.open === true`,
        'branch management open for screenshot',
        5000
      )
    }
    await screenshot('05b-branch-management')

    await click('[data-testid="git-remotes"] summary')
    await waitFor(
      `document.querySelector('[data-testid="git-remotes"]')?.open === true`,
      'remotes management open',
      5000
    )
    await waitForSelector('[data-testid="git-remote-remove-origin"]', 5000)
    await setValue('[data-testid="git-remote-add-name"]', 'backup')
    await setValue('[data-testid="git-remote-add-url"]', REMOTE_DIR)
    await click('[data-testid="git-remote-add"]')
    await waitForNotice('Added remote backup', 20000)
    await waitForSelector('[data-testid="git-remote-remove-backup"]', 10000)
    await click('[data-testid="git-remote-remove-backup"]')
    await waitForNotice('Removed remote backup', 20000)
    await waitFor(
      `!document.querySelector('[data-testid="git-remote-remove-backup"]')`,
      'backup remote removed',
      5000
    )
    await screenshot('05c-remotes')

    const upstreamOption = await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="git-upstream-target"] option')).map((option) => option.value).find((value) => value.startsWith('origin/')) ?? null`
    )
    assert(upstreamOption, 'No remote branch was available for the upstream picker')
    await setValue('[data-testid="git-upstream-target"]', upstreamOption)
    await click('[data-testid="git-upstream-set"]')
    await waitForNotice('Set upstream to', 20000)

    if (!(await cdp.evaluate(`Boolean(document.querySelector('[data-testid="git-branch-menu"]'))`))) {
      await click('[data-testid="git-branch-chip"]')
      await waitForSelector('[data-testid="git-branch-menu"]', 10000)
    }
    await click('[data-testid="git-tags"] summary')
    await waitFor(
      `document.querySelector('[data-testid="git-tags"]')?.open === true`,
      'tags management open',
      5000
    )
    await waitForSelector('[data-testid="git-tag-delete-v-baseline"]', 5000)
    await click('[data-testid="git-push-tags"]')
    await waitForNotice('Pushed tags to origin', 30000)
    await click('[data-testid="git-tag-delete-v-baseline"]')
    await waitForNotice('Deleted tag v-baseline', 20000)
    await waitFor(
      `!document.querySelector('[data-testid="git-tag-delete-v-baseline"]')`,
      'v-baseline deleted',
      5000
    )
    await screenshot('05d-tags')
    await click('[data-testid="git-branch-chip"]')
    return { branch: 'review/smoke-renamed' }
  })

  let sessionId = null
  let worktreePath = null
  await step('commit and amend a change through Changes', async () => {
    const session = await cdp.evaluate(`(async () => {
      const result = await window.ade.sessions.list({});
      return result.ok ? result.value.sessions.find((entry) => entry.title === 'Smoke session') ?? null : null;
    })()`)
    assert(session, 'Could not find the smoke session through the product API')
    sessionId = session.id
    worktreePath = session.worktree?.path ?? null
    assert(worktreePath, 'The smoke session did not expose its worktree path')
    await cdp.evaluate(`(async () => {
      const result = await window.ade.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'README.md', text: 'changed by feature smoke\\n' });
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
    assert(statusBranch.includes('ade/ses_'), 'status bar did not show the session branch')
    await sleep(1200)
    const watchStarted = Date.now()
    await cdp.evaluate(`(async () => {
      const result = await window.ade.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'watcher-live.txt', text: 'written while Changes is open\\n' });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    })()`)
    await waitForSelector('[data-testid="working-file-untracked-watcher-live.txt"]', 8000)
    const watcherLatencyMs = Date.now() - watchStarted
    assert(watcherLatencyMs < 3000, `watcher took ${String(watcherLatencyMs)} ms`)

    await cdp.evaluate(`(async () => {
      const result = await window.ade.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'src/tree-live.txt', text: 'tree view row\\n' });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    })()`)
    await waitForSelector('[data-testid="working-file-untracked-src/tree-live.txt"]', 8000)

    // The commit input and repository header belong to the SCM sidebar.
    assert(
      await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="working-tree"] aside [data-testid="git-commit-message"]'))`
      ),
      'commit input must render inside the SCM sidebar'
    )
    assert(
      await cdp.evaluate(`Boolean(document.querySelector('[data-testid="scm-repo-header"]'))`),
      'the SCM sidebar is missing its repository header'
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
      const result = await window.ade.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'README.md', text: 'signed commit by feature smoke\\n' });
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
    await waitForSelector('[data-testid="scm-setting-smart-commit"]', 10000)
    const card = await cdp.evaluate(`(() => {
      const smart = document.querySelector('[data-testid="scm-setting-smart-commit"]');
      const section = smart?.closest('section');
      return {
        text: section?.innerText ?? '',
        smartCommit: smart?.value ?? null,
        untracked: document.querySelector('[data-testid="scm-setting-untracked"]')?.value ?? null,
        autoFetch: document.querySelector('input[aria-label="Auto-fetch"]')?.checked ?? null,
        autoRefresh: document.querySelector('input[aria-label="Auto-refresh"]')?.checked ?? null
      };
    })()`)
    assert(card.text.includes('Source Control'), 'Settings omitted the Source Control card')
    assert(card.text.includes('Smart commit'), 'Settings omitted the smart-commit field')
    assert(card.smartCommit === 'off', `smart commit default was ${String(card.smartCommit)}`)
    assert(card.untracked === 'separate', `untracked default was ${String(card.untracked)}`)
    assert(card.autoFetch === false, 'auto-fetch must default to off')
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
      `document.querySelector('[data-testid="monaco-editor"]')?.__adeEditor?.focus()`
    )
    await cdp.send('Input.insertText', { text: 'unsaved task draft' })
    await waitForSelector('[data-testid="editor-dirty"]', 10000)
    await click('[data-testid="task-tab-overview"]')
    await sleep(300)
    await click('[data-testid="task-tab-files"]')
    await waitFor(
      `document.querySelector('[data-testid="monaco-editor"]')?.__adeEditor?.getValue().includes('unsaved task draft') === true`,
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
