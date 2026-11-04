'use strict'
/**
 * Real-Electron acceptance for the Source Control surface (Phase 2).
 *
 * Covers the sidebar/editor layout, smart commit, the commit ladder, tree and
 * list views, filtering, batch stage/unstage, discard confirmation, the
 * Ctrl+Shift+G shortcut and the command-palette entry. Screenshots and a JSON
 * result live under artifacts/scm-smoke/.
 */
const { spawn } = require('node:child_process')
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const PACKAGED_EXECUTABLE = process.env.ICODE_SMOKE_EXECUTABLE
  ? resolve(process.env.ICODE_SMOKE_EXECUTABLE)
  : null
const ELECTRON = PACKAGED_EXECUTABLE ?? require('electron')
const ARTIFACT_DIR = join(APP_DIR, 'artifacts', 'scm-smoke')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'icode-scm-smoke-'))
const REPO_DIR = join(RUN_DIR, 'repo')
const REMOTE_DIR = join(RUN_DIR, 'remote.git')
const USER_DATA = join(RUN_DIR, 'userdata')
const EXTRA_WORKTREE_DIR = join(RUN_DIR, 'extra-worktree')
const SUBMODULE_REPO_DIR = join(RUN_DIR, 'sub-repo')

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
let sessionId = null
let worktreePath = null

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}
function log(message) {
  process.stdout.write(`[scm-smoke] ${message}\n`)
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
/**
 * Selects a diff line and waits for its action button.
 *
 * The selected diff can refresh between a plain waitForSelector and click;
 * this loop re-checks the box on the current DOM until the action is visible.
 */
async function selectLineAndWait(checkboxSelector, actionSelector, timeoutMs = 15000) {
  await waitFor(
    `(() => {
      const box = document.querySelector(${JSON.stringify(checkboxSelector)});
      if (!box) return false;
      if (!box.checked) box.click();
      return Boolean(document.querySelector(${JSON.stringify(actionSelector)}));
    })()`,
    `${checkboxSelector} with ${actionSelector}`,
    timeoutMs
  )
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

function git(...args) {
  return require('node:child_process')
    .execFileSync('git', ['-C', REPO_DIR, ...args], { encoding: 'utf8' })
    .trim()
}

async function launch() {
  const logPath = join(ARTIFACT_DIR, 'app.log')
  const logStream = createWriteStream(logPath)
  RUN.artifacts.push(logPath)
  const launchArgs = PACKAGED_EXECUTABLE
    ? ['--no-sandbox', `--remote-debugging-port=${port}`]
    : ['.', `--remote-debugging-port=${port}`]
  appProcess = spawn(ELECTRON, launchArgs, {
    cwd: APP_DIR,
    env: {
      ...process.env,
      ICODE_GATE_USER_DATA: USER_DATA,
      ICODE_BACKGROUND_LAUNCH: '0',
      // The fixture submodule uses an absolute local path. Real users who use
      // file submodules set this in Git config; keep the smoke isolated.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'protocol.file.allow',
      GIT_CONFIG_VALUE_0: 'always'
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

async function openChanges() {
  await click('[data-testid="view-changes"]')
  await waitForSelector('[data-testid="changes-panel"]', 20000)
  await waitFor(
    `Boolean(document.querySelector('[data-testid^="working-file-"]') || document.querySelector('[data-testid="working-tree-empty"]') || document.querySelector('[data-testid="working-tree-unavailable"]'))`,
    'working rows or empty state',
    20000
  )
}

async function reopenSession() {
  if (!(await cdp.evaluate(`Boolean(document.querySelector('[data-testid="projects-wall"]'))`))) {
    await click('[data-testid="rail-projects"]')
    await waitForSelector('[data-testid="projects-wall"]', 15000)
  }
  await click(`[data-testid="open-project-${repoId}"]`)
  await waitForSelector('[data-testid="project-header"]', 20000)
  await click('[data-testid="project-mode-sessions"]')
  await waitForSelector('[data-testid="project-sessions-list"]', 20000)
  await click(`[data-testid="session-item-${sessionId}"]`)
  await waitForSelector('[data-testid="session-title"]', 20000)
}

async function run() {
  mkdirSync(join(REPO_DIR, 'src'), { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'scm@smoke.test')
  git('config', 'user.name', 'SCM Smoke')
  writeFileSync(join(REPO_DIR, 'README.md'), 'scm smoke baseline\n')
  writeFileSync(join(REPO_DIR, 'src', 'app.ts'), 'export const value = 1\n')
  git('add', '.')
  git('commit', '-qm', 'baseline')

  const cp = require('node:child_process')
  mkdirSync(SUBMODULE_REPO_DIR, { recursive: true })
  cp.execFileSync('git', ['init', '-q', '-b', 'main', SUBMODULE_REPO_DIR], { stdio: 'pipe' })
  cp.execFileSync('git', ['-C', SUBMODULE_REPO_DIR, 'config', 'user.email', 'sub@smoke.test'], {
    stdio: 'pipe'
  })
  cp.execFileSync('git', ['-C', SUBMODULE_REPO_DIR, 'config', 'user.name', 'Sub Smoke'], {
    stdio: 'pipe'
  })
  writeFileSync(join(SUBMODULE_REPO_DIR, 'lib.txt'), 'submodule baseline\n')
  cp.execFileSync('git', ['-C', SUBMODULE_REPO_DIR, 'add', '.'], { stdio: 'pipe' })
  cp.execFileSync('git', ['-C', SUBMODULE_REPO_DIR, 'commit', '-qm', 'sub baseline'], {
    stdio: 'pipe'
  })
  git('config', 'protocol.file.allow', 'always')
  cp.execFileSync(
    'git',
    ['-C', REPO_DIR, '-c', 'protocol.file.allow=always', 'submodule', 'add', SUBMODULE_REPO_DIR, 'vendor/lib'],
    { stdio: 'pipe' }
  )
  git('add', '.gitmodules', 'vendor/lib')
  git('commit', '-qm', 'add submodule')
  git('tag', 'v-browse')

  require('node:child_process').execFileSync('git', ['init', '-q', '--bare', REMOTE_DIR], { stdio: 'pipe' })
  require('node:child_process').execFileSync(
    'git',
    ['-C', REPO_DIR, 'worktree', 'add', '--detach', EXTRA_WORKTREE_DIR, 'HEAD'],
    { stdio: 'pipe' }
  )
  git('remote', 'add', 'origin', REMOTE_DIR)
  git('push', '-q', '-u', 'origin', 'main')

  await launch()

  await step('register the smoke repository and create a Shell session', async () => {
    await click('[data-testid="empty-add-repo"]')
    await waitForSelector('[data-testid="add-repo-form"]', 15000)
    await setValue('[data-testid="add-repo-input"]', REPO_DIR)
    await click('[data-testid="add-repo-submit"]')
    await waitForSelector('[data-testid="projects-wall"]', 20000)
    repoId = await cdp.evaluate(
      `document.querySelector('[data-testid^="project-row-"]')?.getAttribute('data-testid')?.replace('project-row-', '') ?? null`
    )
    assert(repoId, 'Repository was not registered')

    await click('[data-testid="new-session-open"]')
    await waitForSelector('[data-testid="harness-option-shell"]', 20000)
    await click('[data-testid="harness-option-shell"]')
    await setValue('[data-testid="session-title-input"]', 'SCM smoke session')
    await click('[data-testid="create-session-submit"]')
    await waitFor(
      `document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') === 'live'`,
      'live session',
      25000
    )
    const session = await cdp.evaluate(`(async () => {
      const result = await window.icode.sessions.list({});
      return result.ok ? result.value.sessions.find((entry) => entry.title === 'SCM smoke session') ?? null : null;
    })()`)
    assert(session, 'Could not find the SCM smoke session')
    sessionId = session.id
    worktreePath = session.worktree?.path ?? null
    assert(worktreePath, 'The session did not expose a worktree path')
    // Publish the session branch so the primary action ladder can reach the
    // stage-first and up-to-date states instead of stopping at Publish Branch.
    require('node:child_process').execFileSync(
      'git',
      ['-C', worktreePath, 'push', '-q', '-u', 'origin', 'HEAD'],
      { stdio: 'pipe' }
    )
    return { repoId, sessionId, worktreePath }
  })

  await step('open Source Control with the repository sidebar', async () => {
    await openChanges()
    await waitFor(
      `document.querySelector('[data-testid="changes-panel"]')?.dataset.watchMode === 'watch'`,
      'worktree watcher active',
      15000
    )
    await waitForSelector('[data-testid="scm-repo-header"]', 10000)
    assert(
      await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="working-tree"] aside [data-testid="git-commit-message"]'))`
      ),
      'the commit input is not inside the SCM sidebar'
    )
    assert(
      await cdp.evaluate(
        `document.querySelector('[data-testid="git-commit"]')?.innerText.includes('Up to date')`
      ),
      'a clean worktree with an upstream should show Up to date'
    )
    await screenshot('01-source-control')
  })

  await step('smart commit is off by default and stages only after opt-in', async () => {
    await cdp.evaluate(`(async () => {
      const result = await window.icode.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'README.md', text: 'smart commit change\\n' });
      if (!result.ok) throw new Error(result.error.message);
      const nested = await window.icode.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'src/app.ts', text: 'export const value = 2\\n' });
      if (!nested.ok) throw new Error(nested.error.message);
      return result.value;
    })()`)
    await waitForSelector('[data-testid="working-file-unstaged-README.md"]', 10000)
    await waitForSelector('[data-testid="working-file-unstaged-src/app.ts"]', 10000)
    await setValueRetry('[data-testid="git-commit-message"]', 'Smart commit smoke')

    const offState = await cdp.evaluate(`(() => {
      const button = document.querySelector('[data-testid="git-commit"]');
      return { label: button?.innerText.trim() ?? '', disabled: button?.disabled ?? null };
    })()`)
    assert(offState.label.includes('Nothing staged'), `smart commit off should show Nothing staged: ${JSON.stringify(offState)}`)
    assert(offState.disabled === true, 'Nothing staged must be disabled while smart commit is off')

    await click('[data-testid="rail-settings"]')
    await waitForSelector('[data-testid="scm-setting-smart-commit"]', 10000)
    await setValue('[data-testid="scm-setting-smart-commit"]', 'all')
    await waitFor(
      `document.querySelector('[data-testid="scm-setting-smart-commit"]')?.value === 'all'`,
      'smart commit setting',
      5000
    )
    const stored = await cdp.evaluate(
      `(() => { try { return JSON.parse(window.localStorage.getItem('icode.scm.settings.v1') ?? 'null') } catch { return null } })()`
    )
    assert(stored?.smartCommit === 'all', 'smart commit was not persisted')

    await reopenSession()
    await openChanges()
    await waitFor(
      `document.querySelector('[data-testid="git-commit"]')?.innerText.includes('Commit All') && !document.querySelector('[data-testid="git-commit"]').disabled`,
      'smart commit primary action',
      10000
    )
    await waitFor(
      `document.querySelector('[data-testid="git-commit-message"]')?.value === 'Smart commit smoke'`,
      'commit message survives the settings round trip',
      10000
    )
    await screenshot('02-smart-commit')
    // Ctrl/Cmd+Enter in the commit input is the keyboard path to the primary action.
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="git-commit-message"]');
      if (!input) return false;
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`)
    await waitForNotice('Committed', 20000)
    const subject = require('node:child_process')
      .execFileSync('git', ['-C', worktreePath, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' })
      .trim()
    assert(subject === 'Smart commit smoke', `unexpected commit subject: ${subject}`)
    const status = require('node:child_process')
      .execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf8' })
      .trim()
    assert(status === '', `worktree not clean after smart commit: ${status}`)
  })

  await step('filter, tree/list and batch stage two untracked files', async () => {
    await cdp.evaluate(`(async () => {
      for (const path of ['src/alpha.txt', 'src/beta.txt']) {
        const result = await window.icode.files.write({ sessionId: ${JSON.stringify(sessionId)}, path, text: path + '\\n' });
        if (!result.ok) throw new Error(result.error.message);
      }
      return true;
    })()`)
    await waitForSelector('[data-testid="working-file-untracked-src/alpha.txt"]', 10000)
    await waitForSelector('[data-testid="working-file-untracked-src/beta.txt"]', 10000)

    await click('[data-testid="scm-view-tree"]')
    await waitForSelector('[data-testid="scm-folder-untracked-src"]', 5000)
    await screenshot('03-tree-view')
    await click('[data-testid="scm-view-list"]')
    await waitFor(
      `!document.querySelector('[data-testid="scm-folder-untracked-src"]')`,
      'list view removes folder rows',
      5000
    )

    // Keyboard model: tree role, roving focus and Arrow key navigation.
    const treeRole = await cdp.evaluate(
      `document.querySelector('[data-testid="working-tree"] aside')?.getAttribute('role') ?? null`
    )
    assert(treeRole === 'tree', `the Source Control sidebar is not a tree (got ${String(treeRole)})`)
    const focused = await cdp.evaluate(`(() => {
      const row = document.querySelector('[data-testid="working-file-untracked-src/alpha.txt"] [role="treeitem"]');
      if (!row) return false;
      row.click();
      row.focus();
      return document.activeElement === row;
    })()`)
    assert(focused, 'could not focus the alpha tree item')
    await cdp.evaluate(`(() => {
      const row = document.activeElement;
      if (!row || row.getAttribute('role') !== 'treeitem') return false;
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      return true;
    })()`)
    await waitFor(
      `Boolean(document.activeElement?.closest('[data-testid="working-file-untracked-src/beta.txt"]'))`,
      'ArrowDown moved SCM row focus',
      5000
    )
    await waitFor(
      `document.activeElement?.getAttribute('aria-selected') === 'true'`,
      'the focused SCM row reports its selection',
      5000
    )
    await cdp.evaluate(`(() => {
      const row = document.activeElement;
      if (!row) return false;
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return true;
    })()`)
    await waitFor(
      `!document.querySelector('[data-testid="scm-batch-bar"]')`,
      'Escape cleared the SCM selection',
      5000
    )

    await setValue('[data-testid="working-tree-search"]', 'alpha')
    await waitFor(
      `!document.querySelector('[data-testid="working-file-untracked-src/beta.txt"]')`,
      'filter hides beta',
      5000
    )
    await setValue('[data-testid="working-tree-search"]', '')
    await waitForSelector('[data-testid="working-file-untracked-src/beta.txt"]', 5000)

    await click('[data-testid="scm-check-untracked-src/alpha.txt"]')
    await click('[data-testid="scm-check-untracked-src/beta.txt"]')
    await waitFor(
      `document.querySelector('[data-testid="scm-batch-bar"]')?.innerText.includes('2 selected')`,
      'batch selection count',
      5000
    )
    await screenshot('04-batch-selection')
    await click('[data-testid="scm-stage-selected"]')
    await waitForSelector('[data-testid="working-file-staged-src/alpha.txt"]', 15000)
    await waitForSelector('[data-testid="working-file-staged-src/beta.txt"]', 15000)
    return { staged: 2 }
  })

  await step('unstage and discard through confirmed row actions', async () => {
    await click('[data-testid="change-stage-staged-src/alpha.txt"]')
    await waitForSelector('[data-testid="working-file-untracked-src/alpha.txt"]', 15000)

    await click('[data-testid="change-discard-untracked-src/alpha.txt"]')
    await waitForSelector('[data-testid="change-discard-confirm"]', 5000)
    await click('[data-testid="change-discard-yes"]')
    await waitFor(
      `!document.querySelector('[data-testid="working-file-untracked-src/alpha.txt"]')`,
      'alpha row removed after discard',
      10000
    )
    assert(!existsSync(join(worktreePath, 'src', 'alpha.txt')), 'discard left alpha.txt on disk')

    await click('[data-testid="change-discard-staged-src/beta.txt"]')
    await waitForSelector('[data-testid="change-discard-confirm"]', 5000)
    await click('[data-testid="change-discard-yes"]')
    await waitFor(
      `!document.querySelector('[data-testid="working-file-staged-src/beta.txt"]')`,
      'beta row removed after discard',
      10000
    )
    await sleep(300)
    assert(!existsSync(join(worktreePath, 'src', 'beta.txt')), 'discard left beta.txt on disk')
    const status = require('node:child_process')
      .execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf8' })
      .trim()
    assert(status === '', `worktree not clean after discards: ${status}`)
    await screenshot('05-after-discard')
  })

  await step('stage and unstage one hunk of a changed file', async () => {
    const exec = require('node:child_process').execFileSync
    const baseline = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    writeFileSync(join(worktreePath, 'hunk.txt'), `${baseline.join('\n')}\n`)
    exec('git', ['-C', worktreePath, 'add', 'hunk.txt'], { stdio: 'pipe' })
    exec('git', ['-C', worktreePath, 'commit', '-qm', 'hunk baseline'], { stdio: 'pipe' })
    baseline[1] = 'line 2 changed'
    baseline[17] = 'line 18 changed'
    writeFileSync(join(worktreePath, 'hunk.txt'), `${baseline.join('\n')}\n`)

    await waitForSelector('[data-testid="working-file-unstaged-hunk.txt"]', 15000)
    await click('[data-testid="working-file-unstaged-hunk.txt"] button[aria-selected]')
    await waitForSelector('[data-testid="review-diff-hunk.txt"]', 10000)
    await waitForSelector('[data-testid="diff-view-unified"]', 10000)
    await click('[data-testid="diff-view-unified"]')
    await waitForSelector('[data-testid="hunk-stage-0"]', 10000)
    const hunkCount = await cdp.evaluate(
      `document.querySelectorAll('[data-testid^="hunk-stage-"]').length`
    )
    assert(hunkCount === 2, `expected two stageable hunks, saw ${hunkCount}`)
    await screenshot('05a-hunk-actions')
    await click('[data-testid="hunk-stage-0"]')
    await waitForSelector('[data-testid="working-file-staged-hunk.txt"]', 15000)
    const cached = exec('git', ['-C', worktreePath, 'diff', '--cached', '--', 'hunk.txt'], {
      encoding: 'utf8'
    })
    assert(cached.includes('line 2 changed'), 'first hunk was not staged')
    assert(!cached.includes('line 18 changed'), 'second hunk was staged by mistake')

    await click('[data-testid="working-file-staged-hunk.txt"] button[aria-selected]')
    await waitForSelector('[data-testid="hunk-unstage-0"]', 10000)
    await click('[data-testid="hunk-unstage-0"]')
    await waitFor(
      `!document.querySelector('[data-testid="working-file-staged-hunk.txt"]')`,
      'unstaged hunk leaves the staged group',
      15000
    )
    const cachedAfter = exec('git', ['-C', worktreePath, 'diff', '--cached', '--', 'hunk.txt'], {
      encoding: 'utf8'
    })
    assert(cachedAfter.trim() === '', `index still holds a hunk: ${cachedAfter}`)

    await click('[data-testid="working-file-unstaged-hunk.txt"] button[aria-selected]')
    // Wait for the post-unstage diff to reload. Before it does, the only hunk
    // shown is the one that stayed unstaged while the first hunk was staged.
    await waitForSelector('[data-testid="hunk-discard-1"]', 15000)
    await click('[data-testid="hunk-discard-0"]')
    await waitForSelector('[data-testid="hunk-discard-yes-0"]', 10000)
    await click('[data-testid="hunk-discard-yes-0"]')
    await waitForNotice('Discarded a hunk', 20000)
    const afterDiscard = require('node:fs').readFileSync(join(worktreePath, 'hunk.txt'), 'utf8')
    assert(afterDiscard.includes('\nline 2\n'), 'discarded hunk did not restore line 2')
    assert(!afterDiscard.includes('line 2 changed'), 'discarded hunk left line 2 changed')
    assert(afterDiscard.includes('line 18 changed'), 'discard removed the wrong hunk')
    exec('git', ['-C', worktreePath, 'checkout', '--', 'hunk.txt'], { stdio: 'pipe' })
    // Remove the fixture commit so the later History ahead/behind assertions
    // still see the command sequence they were written for.
    exec('git', ['-C', worktreePath, 'reset', '--hard', 'HEAD~1'], { stdio: 'pipe' })
    await waitFor(
      `!document.querySelector('[data-testid="working-file-unstaged-hunk.txt"]')`,
      'hunk worktree change restored',
      10000
    )
    return { hunks: hunkCount }
  })

  await step('stage and unstage a single line inside one hunk', async () => {
    const exec = require('node:child_process').execFileSync
    const baseline = Array.from({ length: 6 }, (_, index) => `line ${index + 1}`)
    writeFileSync(join(worktreePath, 'line-level.txt'), `${baseline.join('\n')}\n`)
    exec('git', ['-C', worktreePath, 'add', 'line-level.txt'], { stdio: 'pipe' })
    exec('git', ['-C', worktreePath, 'commit', '-qm', 'line level baseline'], { stdio: 'pipe' })
    baseline[1] = 'line 2 changed'
    baseline[2] = 'line 3 changed'
    writeFileSync(join(worktreePath, 'line-level.txt'), `${baseline.join('\n')}\n`)

    await waitForSelector('[data-testid="working-file-unstaged-line-level.txt"]', 15000)
    await click('[data-testid="working-file-unstaged-line-level.txt"] button[aria-selected]')
    await waitForSelector('[data-testid="review-diff-line-level.txt"]', 10000)
    await waitForSelector('[data-testid="diff-view-unified"]', 10000)
    await click('[data-testid="diff-view-unified"]')
    await waitForSelector('[data-testid="diff-select-new-2"]', 10000)
    await selectLineAndWait(
      '[data-testid="diff-select-new-2"]',
      '[data-testid="hunk-lines-stage-0"]'
    )
    await screenshot('05b-line-selection')
    await click('[data-testid="hunk-lines-stage-0"]')
    await waitForNotice('Staged a hunk', 20000)
    const cached = exec('git', ['-C', worktreePath, 'diff', '--cached', '--', 'line-level.txt'], {
      encoding: 'utf8'
    })
    assert(cached.includes('line 2 changed'), 'selected line was not staged')
    assert(!cached.includes('line 3 changed'), 'unselected line was staged')

    await waitForSelector('[data-testid="working-file-staged-line-level.txt"]', 15000)
    await click('[data-testid="working-file-staged-line-level.txt"] button[aria-selected]')
    await waitForSelector('[data-testid="review-diff-line-level.txt"]', 10000)
    await waitForSelector('[data-testid="diff-select-new-2"]', 10000)
    await selectLineAndWait(
      '[data-testid="diff-select-new-2"]',
      '[data-testid="hunk-lines-unstage-0"]'
    )
    await click('[data-testid="hunk-lines-unstage-0"]')
    await waitForNotice('Unstaged a hunk', 20000)
    const cachedAfter = exec('git', ['-C', worktreePath, 'diff', '--cached', '--', 'line-level.txt'], {
      encoding: 'utf8'
    })
    assert(cachedAfter.trim() === '', `index still holds a line: ${cachedAfter}`)

    // The worktree still has both edits. Wait for the refreshed unstaged diff,
    // then discard only the first selected line.
    await waitForSelector('[data-testid="diff-select-new-3"]', 15000)
    await selectLineAndWait(
      '[data-testid="diff-select-new-2"]',
      '[data-testid="hunk-lines-discard-0"]'
    )
    await click('[data-testid="hunk-lines-discard-0"]')
    await waitForSelector('[data-testid="hunk-lines-discard-yes-0"]', 5000)
    await click('[data-testid="hunk-lines-discard-yes-0"]')
    await waitForNotice('Discarded a hunk', 20000)
    const afterLineDiscard = require('node:fs').readFileSync(
      join(worktreePath, 'line-level.txt'),
      'utf8'
    )
    assert(afterLineDiscard.includes('\nline 2\n'), 'selected line discard did not restore line 2')
    assert(!afterLineDiscard.includes('line 2 changed'), 'selected line discard left line 2 changed')
    assert(afterLineDiscard.includes('line 3 changed'), 'selected line discard removed line 3')
    exec('git', ['-C', worktreePath, 'checkout', '--', 'line-level.txt'], { stdio: 'pipe' })
    exec('git', ['-C', worktreePath, 'reset', '--hard', 'HEAD~1'], { stdio: 'pipe' })
    await waitFor(
      `!document.querySelector('[data-testid="working-file-unstaged-line-level.txt"]')`,
      'line-level fixture cleaned up',
      10000
    )
    return { staged: 'new line 2 only' }
  })

  await step('stash changes, inspect, apply and pop', async () => {
    const exec = require('node:child_process').execFileSync
    await cdp.evaluate(`(async () => {
      const tracked = await window.icode.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'README.md', text: 'stash tracked change\\n' });
      if (!tracked.ok) throw new Error(tracked.error.message);
      const untracked = await window.icode.files.write({ sessionId: ${JSON.stringify(sessionId)}, path: 'stash-untracked.txt', text: 'stash untracked\\n' });
      if (!untracked.ok) throw new Error(untracked.error.message);
      return true;
    })()`)
    await waitForSelector('[data-testid="working-file-unstaged-README.md"]', 15000)
    await waitForSelector('[data-testid="working-file-untracked-stash-untracked.txt"]', 15000)
    await click('[data-testid="scm-stash-toggle-compose"]')
    await waitForSelector('[data-testid="scm-stash-message"]', 5000)
    await setValue('[data-testid="scm-stash-message"]', 'smoke stash')
    await click('[data-testid="scm-stash-untracked"]')
    await click('[data-testid="scm-stash-create"]')
    await waitForNotice('Stashed changes', 20000)
    await waitForSelector('[data-testid="scm-stash-row-0"]', 15000)
    await waitFor(
      `!document.querySelector('[data-testid="working-file-unstaged-README.md"]') && !document.querySelector('[data-testid="working-file-untracked-stash-untracked.txt"]')`,
      'stash removed the worktree changes',
      15000
    )
    await click('[data-testid="scm-stash-open-0"]')
    await waitForSelector('[data-testid="scm-stash-detail"]', 10000)
    await waitForSelector('[data-testid="scm-stash-file-README.md"]', 10000)
    await waitForSelector('[data-testid="scm-stash-file-stash-untracked.txt"]', 10000)
    const stashDetail = await cdp.evaluate(
      `document.querySelector('[data-testid="scm-stash-detail"]')?.innerText ?? ''`
    )
    assert(stashDetail.includes('stash tracked change'), 'stash diff did not show the tracked edit')
    await screenshot('05c-stash')
    await click('[data-testid="scm-stash-close"]')
    await click('[data-testid="scm-stash-apply-0"]')
    await waitForNotice('Applied stash@{0}', 20000)
    await waitForSelector('[data-testid="working-file-unstaged-README.md"]', 15000)
    assert(
      require('node:fs').readFileSync(join(worktreePath, 'stash-untracked.txt'), 'utf8') ===
        'stash untracked\n',
      'stash apply did not restore the untracked file'
    )
    assert(
      await cdp.evaluate(`Boolean(document.querySelector('[data-testid="scm-stash-row-0"]'))`),
      'apply removed the stash entry'
    )
    exec('git', ['-C', worktreePath, 'checkout', '--', 'README.md'], { stdio: 'pipe' })
    require('node:fs').unlinkSync(join(worktreePath, 'stash-untracked.txt'))
    await waitFor(
      `!document.querySelector('[data-testid="working-file-unstaged-README.md"]')`,
      'applied change cleaned up before pop',
      10000
    )
    await click('[data-testid="scm-stash-pop-0"]')
    await waitForNotice('Popped stash@{0}', 20000)
    await waitForSelector('[data-testid="working-file-unstaged-README.md"]', 15000)
    await waitFor(
      `!document.querySelector('[data-testid="scm-stash-row-0"]')`,
      'pop removed the stash entry',
      10000
    )
    exec('git', ['-C', worktreePath, 'checkout', '--', 'README.md'], { stdio: 'pipe' })
    require('node:fs').unlinkSync(join(worktreePath, 'stash-untracked.txt'))
    await waitFor(
      `!document.querySelector('[data-testid="working-file-unstaged-README.md"]')`,
      'popped change cleaned up',
      10000
    )
  })

  await step('locks, unlocks and removes an unowned worktree', async () => {
    await waitForSelector('[data-testid="scm-worktrees"]', 15000)
    const worktreeInfo = await waitFor(
      `(() => {
        const rows = [...document.querySelectorAll('[data-testid^="scm-worktree-row-"]')];
        const extra = rows.find((row) => row.innerText.toLowerCase().includes('extra-worktree'));
        const primary = rows.find((row) => row.innerText.toLowerCase().includes('primary'));
        const owned = rows.find((row) => row.innerText.toLowerCase().includes('session'));
        if (!extra || !primary || !owned) return false;
        const index = extra.getAttribute('data-testid').replace('scm-worktree-row-', '');
        return {
          index,
          primaryRemoveDisabled: primary.querySelector('[data-testid^="scm-worktree-remove-"]')?.disabled === true,
          sessionRemoveDisabled: owned.querySelector('[data-testid^="scm-worktree-remove-"]')?.disabled === true,
          sessionLockDisabled: owned.querySelector('[data-testid^="scm-worktree-lock-"]')?.disabled === true
        };
      })()`,
      'worktree rows',
      15000
    )
    assert(worktreeInfo.primaryRemoveDisabled, 'the primary checkout remove action is enabled')
    assert(worktreeInfo.sessionRemoveDisabled, 'the session worktree remove action is enabled')
    assert(worktreeInfo.sessionLockDisabled, 'the session worktree lock action is enabled')
    const index = worktreeInfo.index
    await screenshot('05d-worktrees')
    await click(`[data-testid="scm-worktree-lock-${index}"]`)
    await waitForNotice('Locked worktree', 15000)
    await waitFor(
      `document.querySelector('[data-testid="scm-worktree-row-${index}"]')?.innerText.toLowerCase().includes('locked')`,
      'worktree locked badge',
      10000
    )
    await click(`[data-testid="scm-worktree-unlock-${index}"]`)
    await waitForNotice('Unlocked worktree', 15000)
    await waitFor(
      `!document.querySelector('[data-testid="scm-worktree-row-${index}"]')?.innerText.toLowerCase().includes('locked')`,
      'worktree unlocked badge',
      10000
    )
    await click(`[data-testid="scm-worktree-remove-${index}"]`)
    await waitForSelector(`[data-testid="scm-worktree-remove-yes-${index}"]`, 5000)
    await click(`[data-testid="scm-worktree-remove-yes-${index}"]`)
    await waitForNotice('Removed worktree', 15000)
    await waitFor(
      `![...document.querySelectorAll('[data-testid^="scm-worktree-row-"]')].some((row) => row.innerText.includes('extra-worktree'))`,
      'extra worktree row removed',
      10000
    )
    assert(!existsSync(EXTRA_WORKTREE_DIR), 'the extra worktree directory still exists')
    await click('[data-testid="scm-worktrees-prune"]')
    await waitForNotice('Pruned worktrees', 15000)
  })

  await step('initializes, updates, syncs and stages a submodule', async () => {
    const exec = require('node:child_process').execFileSync
    await waitForSelector('[data-testid="scm-submodules"]', 15000)
    await waitForSelector('[data-testid="scm-submodule-row-vendor/lib"]', 15000)
    const initial = await cdp.evaluate(
      `document.querySelector('[data-testid="scm-submodule-row-vendor/lib"]')?.innerText.toLowerCase() ?? ''`
    )
    assert(initial.includes('not initialized'), `submodule did not start uninitialized: ${initial}`)
    await click('[data-testid="scm-submodule-init-vendor/lib"]')
    await waitForNotice('Initialized vendor/lib', 20000)
    await click('[data-testid="scm-submodule-update-vendor/lib"]')
    await waitForNotice('Updated vendor/lib', 30000)
    await waitFor(
      `document.querySelector('[data-testid="scm-submodule-row-vendor/lib"]')?.innerText.toLowerCase().includes('clean')`,
      'submodule clean after update',
      15000
    )
    await click('[data-testid="scm-submodule-sync-vendor/lib"]')
    await waitForNotice('Synced vendor/lib', 20000)

    const subPath = join(worktreePath, 'vendor', 'lib')
    exec('git', ['-C', subPath, 'config', 'user.email', 'sub@smoke.test'], { stdio: 'pipe' })
    exec('git', ['-C', subPath, 'config', 'user.name', 'Sub Smoke'], { stdio: 'pipe' })
    writeFileSync(join(subPath, 'lib.txt'), 'submodule changed\n')
    exec('git', ['-C', subPath, 'commit', '-qam', 'sub change'], { stdio: 'pipe' })
    await waitFor(
      `document.querySelector('[data-testid="scm-submodule-row-vendor/lib"]')?.innerText.toLowerCase().includes('pointer changed')`,
      'submodule pointer changed badge',
      15000
    )
    await click('[data-testid="scm-submodule-stage-vendor/lib"]')
    await waitForNotice('Staged vendor/lib', 20000)
    await waitFor(
      `document.querySelector('[data-testid="scm-submodule-row-vendor/lib"]')?.innerText.toLowerCase().includes('clean')`,
      'submodule clean after staging pointer',
      15000
    )
    await screenshot('05e-submodules')

    exec('git', ['-C', worktreePath, 'reset', '-q', '--', 'vendor/lib'], { stdio: 'pipe' })
    exec('git', ['-C', subPath, 'checkout', '-q', 'HEAD~1'], { stdio: 'pipe' })
  })

  await step('browses tags in the sidebar', async () => {
    await waitForSelector('[data-testid="scm-tags"]', 15000)
    await waitForSelector('[data-testid="scm-tag-row-v-browse"]', 15000)
    await click('[data-testid="scm-tag-checkout-v-browse"]')
    await waitForSelector('[data-testid="scm-tag-checkout-yes-v-browse"]', 5000)
    await screenshot('05f-tags')
    await click('[data-testid="scm-tag-checkout-cancel-v-browse"]')
    await waitFor(
      `!document.querySelector('[data-testid="scm-tag-checkout-yes-v-browse"]')`,
      'tag checkout confirmation cancelled',
      5000
    )
    await waitForSelector('[data-testid="scm-tag-row-v-browse"]', 5000)
  })

  await step('hidden Source Control releases its watcher', async () => {
    const readSummary = () =>
      cdp.evaluate(`(() => {
        const element = document.querySelector('[data-testid="statusbar-branch"]');
        const match = element?.title.match(/(\\d+) staged · (\\d+) changed · (\\d+) untracked/);
        return match ? { staged: Number(match[1]), changed: Number(match[2]), untracked: Number(match[3]) } : null;
      })()`)
    const before = await readSummary()
    assert(before, 'the status bar did not show a Git summary')

    await click('[data-testid="view-files"]')
    await waitForSelector('[data-testid="files-view"]', 10000)
    // The watcher stop is asynchronous; let the cleanup settle before writing.
    await sleep(1500)
    writeFileSync(join(worktreePath, 'hidden-pane.txt'), 'hidden pane\n')
    await sleep(3000)
    const hidden = await readSummary()
    assert(hidden, 'the status bar summary disappeared while Source Control was hidden')
    assert(
      hidden.untracked === before.untracked && hidden.changed === before.changed,
      `hidden Source Control refreshed its status: before=${JSON.stringify(before)} during=${JSON.stringify(hidden)}`
    )

    await click('[data-testid="view-changes"]')
    await waitForSelector('[data-testid="working-file-untracked-hidden-pane.txt"]', 10000)
    await waitFor(
      `document.querySelector('[data-testid="statusbar-branch"]')?.title.includes('${before.untracked + 1} untracked')`,
      'status bar refreshed when Source Control returned',
      10000
    )
    unlinkSync(join(worktreePath, 'hidden-pane.txt'))
    await waitFor(
      `!document.querySelector('[data-testid="working-file-untracked-hidden-pane.txt"]')`,
      'hidden-pane cleanup',
      10000
    )
  })

  await step('Ctrl+Shift+G focuses Source Control', async () => {
    await click('[data-testid="view-terminal"]')
    await waitFor(
      `document.querySelector('[data-testid="view-changes"]')?.getAttribute('aria-selected') === 'false'`,
      'terminal tab active',
      5000
    )
    await cdp.evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`
    )
    await waitFor(
      `document.querySelector('[data-testid="view-changes"]')?.getAttribute('aria-selected') === 'true'`,
      'Source Control focused by shortcut',
      5000
    )
  })

  await step('the command palette reaches Source Control', async () => {
    await click('[data-testid="view-terminal"]')
    await cdp.evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`
    )
    await waitForSelector('[data-testid="command-palette"]', 10000)
    await setValue('[data-testid="command-palette-input"]', 'Source Control')
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="command-palette-item"]')).some((el) => el.innerText.includes('Go to Source Control'))`,
      'Source Control palette action',
      10000
    )
    await cdp.evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('[data-testid="command-palette-item"]')).find((el) => el.innerText.includes('Go to Source Control'));
      if (!item) return false;
      item.click();
      return true;
    })()`)
    await waitFor(
      `!document.querySelector('[data-testid="command-palette"]')`,
      'palette closed',
      5000
    )
    await waitFor(
      `document.querySelector('[data-testid="view-changes"]')?.getAttribute('aria-selected') === 'true'`,
      'Source Control focused from the palette',
      5000
    )
    await screenshot('06-palette-source-control')

    // Registered Source Control commands, not only the navigation action.
    await cdp.evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`
    )
    await waitForSelector('[data-testid="command-palette"]', 10000)
    await setValue('[data-testid="command-palette-input"]', 'Git: View History')
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="command-palette-item"]')).some((el) => el.innerText.includes('Git: View History'))`,
      'Git View History palette action',
      10000
    )
    await cdp.evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('[data-testid="command-palette-item"]')).find((el) => el.innerText.includes('Git: View History'));
      if (!item) return false;
      item.click();
      return true;
    })()`)
    await waitForSelector('[data-testid="scm-history"]', 15000)
    await click('[data-testid="scm-history-close"]')
    await waitFor(
      `!document.querySelector('[data-testid="scm-history"]')`,
      'Git View History command closed',
      5000
    )
  })

  await step('browse History, inspect a commit and open its file diff', async () => {
    await click('[data-testid="scm-history-open"]')
    await waitForSelector('[data-testid="scm-history"]', 15000)
    await waitForSelector('[data-testid="scm-history-list"]', 15000)
    await waitForSelector('[data-testid^="scm-history-commit-"]', 15000)
    const lane = await cdp.evaluate(
      `document.querySelector('[data-testid^="scm-history-lane-"]')?.tagName ?? null`
    )
    assert(lane === 'svg', `History did not render a lane graph (got ${String(lane)})`)
    await waitForSelector('[data-testid="scm-history-outgoing"]', 5000)
    const outgoing = await cdp.evaluate(
      `document.querySelector('[data-testid="scm-history-outgoing"]')?.textContent ?? ''`
    )
    assert(outgoing.includes('1'), `the smart commit should be one ahead: ${outgoing}`)

    const commitIds = await cdp.evaluate(
      `[...document.querySelectorAll('[data-testid^="scm-history-commit-"]')].slice(0, 2).map((element) => element.getAttribute('data-testid').replace('scm-history-commit-', ''))`
    )
    assert(commitIds.length === 2, `expected two commits for range compare: ${JSON.stringify(commitIds)}`)
    await click(`[data-testid="scm-history-check-${commitIds[0]}"]`)
    await click(`[data-testid="scm-history-check-${commitIds[1]}"]`)
    await waitForSelector('[data-testid="scm-history-selection"]', 5000)
    await click('[data-testid="scm-history-compare-selected"]')
    await waitForSelector('[data-testid="scm-range-compare"]', 15000)
    await waitForSelector('[data-testid="scm-range-header"]', 5000)
    await waitForSelector('[data-testid^="scm-range-file-"]', 15000)
    const rangeFile = await cdp.evaluate(
      `document.querySelector('[data-testid^="scm-range-file-"]')?.getAttribute('data-testid') ?? null`
    )
    assert(rangeFile, 'range compare has no file rows')
    await click(`[data-testid="${rangeFile}"]`)
    await waitForSelector('[data-testid="scm-range-file-diff"]', 15000)
    await screenshot('12-range-compare')
    await click('[data-testid="scm-range-back"]')
    await waitFor(
      `!document.querySelector('[data-testid="scm-range-compare"]')`,
      'range compare closed',
      5000
    )
    await click('[data-testid="scm-history-clear-selection"]')

    await setValue('[data-testid="scm-history-ref"]', 'ALL')
    await waitForSelector('[data-testid="scm-history-list"]', 10000)
    await setValue('[data-testid="scm-history-ref"]', 'HEAD')
    await waitForSelector('[data-testid="scm-history-list"]', 10000)
    await click('[data-testid="scm-history-view-timeline"]')
    await waitForSelector('[data-testid="scm-history-timeline"]', 5000)
    await waitForSelector('[data-testid^="scm-history-commit-"]', 5000)
    const timelineLabel = await cdp.evaluate(
      `document.querySelector('[data-testid="scm-history-timeline"] section h3')?.innerText ?? ''`
    )
    assert(timelineLabel.trim().length > 0, 'Timeline did not render a date group')
    await click('[data-testid="scm-history-view-list"]')
    await waitFor(
      `!document.querySelector('[data-testid="scm-history-timeline"]')`,
      'timeline toggled back to list',
      5000
    )
    await screenshot('07-history')

    const first = await cdp.evaluate(
      `document.querySelector('[data-testid^="scm-history-commit-"]')?.getAttribute('data-testid') ?? null`
    )
    assert(first, 'No History commit row')
    const smartOid = require('node:child_process')
      .execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
      .trim()
    await click(`[data-testid="${first}"]`)
    await waitFor(
      `document.querySelector('[data-testid="scm-history-detail"]')?.innerText.includes('Smart commit smoke')`,
      'commit detail subject',
      10000
    )
    await waitForSelector('[data-testid="scm-history-file-README.md"]', 10000)
    await waitForSelector('[data-testid="scm-history-file-src/app.ts"]', 10000)
    await screenshot('08-commit-detail')

    // List/tree presentation of the commit's files (VS Code's two History modes).
    await click('[data-testid="scm-history-files-tree"]')
    await waitForSelector('[data-testid="scm-history-folder-src"]', 5000)
    await waitForSelector('[data-testid="scm-history-file-src/app.ts"]', 5000)
    await screenshot('08b-commit-file-tree')
    await click('[data-testid="scm-history-folder-src"]')
    await waitFor(
      `!document.querySelector('[data-testid="scm-history-file-src/app.ts"]')`,
      'collapsing a History folder hides its file',
      5000
    )
    await click('[data-testid="scm-history-folder-src"]')
    await waitForSelector('[data-testid="scm-history-file-src/app.ts"]', 5000)
    await click('[data-testid="scm-history-files-list"]')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="scm-history-file-src/app.ts"]')) && !document.querySelector('[data-testid="scm-history-folder-src"]')`,
      'History list mode flattens the changed files',
      5000
    )

    await click('[data-testid="scm-history-file-README.md"]')
    await waitForSelector('[data-testid="scm-history-file-diff"]', 10000)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="monaco-diff"]')?.__icodeDiff) || Boolean(document.querySelector('[data-testid="review-diff-README.md"]'))`,
      'commit file diff mounted',
      20000
    )
    const diffText = await cdp.evaluate(`(() => {
      const diff = document.querySelector('[data-testid="monaco-diff"]')?.__icodeDiff;
      if (diff) return diff.getModel()?.modified.getValue() ?? '';
      return document.querySelector('[data-testid="review-diff-README.md"]')?.innerText ?? '';
    })()`)
    assert(diffText.includes('smart commit change'), 'the commit file diff did not show the change')
    const monacoDiff = await cdp.evaluate(
      `Boolean(document.querySelector('[data-testid="monaco-diff"] .monaco-diff-editor'))`
    )
    assert(monacoDiff, 'the commit file diff did not render the Monaco diff editor')
    await screenshot('09-commit-file-diff')

    await click('[data-testid="scm-history-file-back"]')
    await waitForSelector('[data-testid="scm-history-file-README.md"]', 5000)

    await click('[data-testid="scm-history-open-all"]')
    await waitForSelector('[data-testid="scm-multi-diff"]', 10000)
    await waitForSelector('[data-testid="scm-multi-file-README.md"]', 10000)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="scm-multi-file-README.md"] [data-testid="monaco-diff"]')?.__icodeDiff) || Boolean(document.querySelector('[data-testid="scm-multi-file-README.md"] [data-testid="review-diff-README.md"]'))`,
      'multi-diff section mounted',
      20000
    )
    await screenshot('10-commit-multi-diff')
    await click('[data-testid="scm-multi-diff-back"]')
    await waitForSelector('[data-testid="scm-history-file-README.md"]', 5000)

    // Branch and tag creation at the selected commit.
    await click('[data-testid="scm-commit-actions"]')
    await waitForSelector('[data-testid="scm-commit-create-branch"]', 5000)
    await click('[data-testid="scm-commit-create-branch"]')
    await waitForSelector('[data-testid="scm-commit-dialog"]', 5000)
    await setValue('[data-testid="scm-commit-name"]', 'review/history-smoke')
    await click('[data-testid="scm-commit-confirm"]')
    await waitForNotice('Created branch review/history-smoke', 10000)
    const branchOid = require('node:child_process')
      .execFileSync('git', ['-C', worktreePath, 'rev-parse', 'review/history-smoke'], {
        encoding: 'utf8'
      })
      .trim()
    assert(branchOid === smartOid, 'the new branch does not point at the selected commit')

    await click('[data-testid="scm-commit-actions"]')
    await waitForSelector('[data-testid="scm-commit-create-tag"]', 5000)
    await click('[data-testid="scm-commit-create-tag"]')
    await waitForSelector('[data-testid="scm-commit-dialog"]', 5000)
    await setValue('[data-testid="scm-commit-name"]', 'v-smoke')
    await click('[data-testid="scm-commit-confirm"]')
    await waitForNotice('Created tag v-smoke', 10000)
    const tags = require('node:child_process')
      .execFileSync('git', ['-C', worktreePath, 'tag', '--list'], { encoding: 'utf8' })
    assert(tags.split('\n').includes('v-smoke'), 'the tag was not created')

    // Revert creates a commit, then a hard reset puts the branch back.
    await click('[data-testid="scm-commit-actions"]')
    await waitForSelector('[data-testid="scm-commit-revert"]', 5000)
    await click('[data-testid="scm-commit-revert"]')
    await waitForSelector('[data-testid="scm-commit-dialog"]', 5000)
    await screenshot('11-commit-action-dialog')
    await click('[data-testid="scm-commit-confirm"]')
    await waitForNotice('Reverted as', 15000)
    const revertSubject = require('node:child_process')
      .execFileSync('git', ['-C', worktreePath, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' })
      .trim()
    assert(revertSubject.startsWith('Revert'), `revert did not create a commit: ${revertSubject}`)
    await waitFor(
      `!document.querySelector('[data-testid="scm-commit-actions"]')?.disabled`,
      'commit actions ready after revert',
      15000
    )

    await click('[data-testid="scm-commit-actions"]')
    await waitForSelector('[data-testid="scm-commit-reset"]', 5000)
    await click('[data-testid="scm-commit-reset"]')
    await waitForSelector('[data-testid="scm-reset-mode"]', 5000)
    await setValue('[data-testid="scm-reset-mode"]', 'hard')
    await waitFor(
      `!document.querySelector('[data-testid="scm-commit-confirm"]')?.disabled`,
      'reset confirm enabled',
      10000
    )
    await click('[data-testid="scm-commit-confirm"]')
    await waitForNotice('(hard)', 20000)
    const headAfterReset = require('node:child_process')
      .execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
      .trim()
    assert(headAfterReset === smartOid, 'the hard reset did not move HEAD to the selected commit')
    const cleanAfterReset = require('node:child_process')
      .execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf8' })
      .trim()
    assert(cleanAfterReset === '', `the hard reset left changes: ${cleanAfterReset}`)

    await click('[data-testid="scm-history-close"]')
    await waitFor(
      `!document.querySelector('[data-testid="scm-history"]')`,
      'History closed',
      5000
    )
  })

  await step('open History for a file from Files', async () => {
    await click('[data-testid="view-files"]')
    await waitForSelector('[data-testid="files-panel"]', 15000)
    await waitForSelector('[data-testid="files-entry-README.md"]', 15000)
    await click('[data-testid="files-entry-README.md"]')
    await waitForSelector('[data-testid="code-editor"]', 10000)
    await click('[data-testid="files-open-history"]')
    await waitForSelector('[data-testid="scm-history"]', 15000)
    await waitForSelector('[data-testid="scm-history-path"]', 10000)
    const pathText = await cdp.evaluate(
      `document.querySelector('[data-testid="scm-history-path"]')?.innerText ?? ''`
    )
    assert(pathText.includes('README.md'), `History path filter did not show the file: ${pathText}`)
    await waitForSelector('[data-testid="scm-history-list"]', 15000)
    await waitForSelector('[data-testid^="scm-history-commit-"]', 15000)
    await screenshot('12-file-history')
    await click('[data-testid="scm-history-clear-path"]')
    await waitFor(
      `!document.querySelector('[data-testid="scm-history-path"]')`,
      'path filter cleared',
      5000
    )
    await waitForSelector('[data-testid="scm-history-list"]', 10000)
    await click('[data-testid="scm-history-close"]')
    await waitFor(
      `!document.querySelector('[data-testid="scm-history"]')`,
      'file History closed',
      5000
    )
  })

  await step('resolves a merge conflict in the merge editor and continues', async () => {
    const cp = require('node:child_process')
    const run = (args, allowFailure = false) => {
      try {
        return cp.execFileSync('git', ['-C', worktreePath, ...args], { encoding: 'utf8' }).trim()
      } catch (error) {
        if (allowFailure) return ''
        throw error
      }
    }
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
    const base = run(['rev-parse', 'HEAD~1'])
    run(['checkout', '-q', '-b', 'op-side', base])
    writeFileSync(join(worktreePath, 'src', 'app.ts'), 'merge side\n')
    run(['commit', '-qam', 'merge side'])
    run(['checkout', '-q', branch])
    writeFileSync(join(worktreePath, 'src', 'app.ts'), 'current side\n')
    run(['commit', '-qam', 'current side'])
    run(['merge', 'op-side'], true)

    await waitForSelector('[data-testid="scm-operation-banner"]', 15000)
    await waitForSelector('[data-testid="working-file-conflicts-src/app.ts"]', 15000)
    const continueDisabled = await cdp.evaluate(
      `document.querySelector('[data-testid="scm-operation-continue"]')?.disabled ?? null`
    )
    assert(continueDisabled === true, 'Continue must be disabled while conflicts remain')
    await click('[data-testid="working-file-conflicts-src/app.ts"]')
    await waitForSelector('[data-testid="merge-editor"]', 15000)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="merge-result"]')?.__icodeEditor) && Boolean(document.querySelector('[data-testid="merge-pane-incoming"]')?.__icodeEditor)`,
      'merge editor Monaco panes',
      20000
    )
    const mergeState = await cdp.evaluate(`(() => {
      const value = (id) => document.querySelector('[data-testid="' + id + '"]')?.__icodeEditor?.getModel()?.getValue() ?? null;
      return {
        result: value('merge-result'),
        current: value('merge-pane-current'),
        incoming: value('merge-pane-incoming'),
        base: value('merge-pane-base'),
        count: document.querySelector('[data-testid="merge-conflict-count"]')?.innerText ?? null
      };
    })()`)
    assert(mergeState.count?.toLowerCase().includes('1 conflict'), `conflict count missing: ${JSON.stringify(mergeState)}`)
    assert(mergeState.result?.includes('<<<<<<<'), 'merge result has no marker')
    assert(mergeState.current && mergeState.incoming, 'merge panes did not load both sides')
    assert(mergeState.current !== mergeState.incoming, 'merge sides are identical')
    assert(mergeState.base !== null, 'merge base pane is missing')
    await screenshot('13-merge-editor')

    // The diff toggle stays available for users who prefer markers.
    await click('[data-testid="merge-show-diff"]')
    await waitForSelector('[data-testid="review-diff-src/app.ts"]', 10000)
    const conflictText = await cdp.evaluate(
      `document.querySelector('[data-testid="review-diff-src/app.ts"]')?.innerText ?? ''`
    )
    assert(
      conflictText.includes('<<<<<<<') || conflictText.includes('======='),
      `the conflict diff did not show markers: ${conflictText.slice(0, 300)}`
    )
    await click('[data-testid="merge-open"]')
    await waitForSelector('[data-testid="merge-editor"]', 15000)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="merge-result"]')?.__icodeEditor)`,
      'merge editor reloaded',
      20000
    )
    await click('[data-testid="merge-toggle-base"]')
    await waitFor(
      `!document.querySelector('[data-testid="merge-pane-base"]')`,
      'base pane toggled off',
      5000
    )
    await click('[data-testid="merge-toggle-base"]')
    await waitForSelector('[data-testid="merge-pane-base"]', 5000)

    await click('[data-testid="merge-accept-incoming"]')
    await waitFor(
      `document.querySelector('[data-testid="merge-result"]')?.__icodeEditor?.getModel()?.getValue() === 'merge side\\n'`,
      'accepted incoming result',
      10000
    )
    await waitFor(
      `!document.querySelector('[data-testid="merge-save"]')?.disabled`,
      'merge save enabled after resolution',
      5000
    )
    await screenshot('13a-merge-resolved')
    await click('[data-testid="merge-save"]')
    await waitForNotice('Resolved src/app.ts', 20000)
    await waitFor(
      `!document.querySelector('[data-testid="scm-operation-continue"]')?.disabled`,
      'merge continue enabled after staging',
      15000
    )
    await click('[data-testid="scm-operation-continue"]')
    await waitForNotice('Continued merge', 20000)
    await waitFor(
      `!document.querySelector('[data-testid="scm-operation-banner"]')`,
      'operation banner cleared',
      10000
    )
    const status = run(['status', '--porcelain'])
    assert(status === '', `continuing the merge left changes: ${status}`)
    assert(run(['log', '-1', '--pretty=%s']).startsWith("Merge branch 'op-side'"), 'merge commit missing')
    assert(
      require('node:fs').readFileSync(join(worktreePath, 'src', 'app.ts'), 'utf8') === 'merge side\n',
      'the resolved result was not written'
    )
    run(['branch', '-D', 'op-side'])
  })

  await step('auto-fetches while Source Control is visible', async () => {
    await click('[data-testid="rail-settings"]')
    await waitForSelector('[data-testid="settings-view"]', 15000)
    await waitForSelector('[data-testid="scm-setting-auto-fetch"]', 10000)
    const alreadyOn = await cdp.evaluate(
      `document.querySelector('[data-testid="scm-setting-auto-fetch"]')?.checked === true`
    )
    if (!alreadyOn) await click('[data-testid="scm-setting-auto-fetch"]')
    await setValue('[data-testid="scm-setting-auto-fetch-interval"]', '30')
    const stored = await cdp.evaluate(
      `(() => { try { return JSON.parse(window.localStorage.getItem('icode.scm.settings.v1') ?? 'null') } catch { return null } })()`
    )
    assert(stored?.autoFetch === true, 'auto-fetch was not enabled')
    assert(stored?.autoFetchIntervalSec === 30, 'auto-fetch interval was not 30 seconds')

    await reopenSession()
    await openChanges()

    const cp = require('node:child_process')
    const branch = cp
      .execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8'
      })
      .trim()
    const cloneDir = join(RUN_DIR, 'autofetch-clone')
    cp.execFileSync('git', ['clone', '-q', '-b', branch, REMOTE_DIR, cloneDir], {
      stdio: 'pipe'
    })
    cp.execFileSync('git', ['-C', cloneDir, 'config', 'user.email', 'remote@smoke.test'], {
      stdio: 'pipe'
    })
    cp.execFileSync('git', ['-C', cloneDir, 'config', 'user.name', 'Remote Smoke'], {
      stdio: 'pipe'
    })
    writeFileSync(join(cloneDir, 'README.md'), 'remote auto-fetch change\n')
    cp.execFileSync('git', ['-C', cloneDir, 'commit', '-qam', 'remote auto-fetch'], {
      stdio: 'pipe'
    })
    cp.execFileSync('git', ['-C', cloneDir, 'push', '-q', 'origin', branch], { stdio: 'pipe' })

    await waitForSelector('[data-testid="scm-repo-behind"]', 45000)
    const behind = await cdp.evaluate(
      `document.querySelector('[data-testid="scm-repo-behind"]')?.textContent ?? ''`
    )
    assert(behind.includes('1'), `auto-fetch did not report one incoming commit: ${behind}`)
    await screenshot('14-auto-fetch')
  })

  await step('edit and save a file in Monaco', async () => {
    await click('[data-testid="view-files"]')
    await waitForSelector('[data-testid="files-panel"]', 15000)
    await waitForSelector('[data-testid="files-entry-README.md"]', 15000)
    await click('[data-testid="files-entry-README.md"]')
    await waitForSelector('[data-testid="code-editor"]', 10000)
    await waitForSelector('[data-testid="monaco-editor"]', 20000)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="monaco-editor"] .monaco-editor'))`,
      'Monaco editor mounted',
      20000
    )
    assert(
      !(await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="editor-monaco-fallback"]'))`
      )),
      'Monaco fell back to the plain editor'
    )
    const workerCheck = await cdp.evaluate(`(async () => {
      try {
        const environment = window.MonacoEnvironment;
        if (!environment || typeof environment.getWorker !== 'function') {
          return { ok: false, reason: 'no MonacoEnvironment.getWorker' };
        }
        const worker = environment.getWorker('editorWorkerService', '');
        if (!(worker instanceof Worker)) return { ok: false, reason: 'not a Worker' };
        const outcome = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve('constructed'), 400);
          worker.onerror = (event) => {
            clearTimeout(timer);
            resolve('worker-error: ' + (event.message || 'unknown'));
          };
          worker.onmessage = () => {
            clearTimeout(timer);
            resolve('message');
          };
        });
        worker.terminate();
        return { ok: outcome === 'constructed' || outcome === 'message', outcome };
      } catch (error) {
        return { ok: false, reason: String(error) };
      }
    })()`)
    assert(workerCheck.ok, `Monaco inline worker failed: ${JSON.stringify(workerCheck)}`)
    await waitForSelector('[data-testid="editor-quick-diff"]', 15000)
    const quickBefore = await cdp.evaluate(
      `document.querySelector('[data-testid="editor-quick-diff"]')?.textContent ?? ''`
    )
    await waitForSelector('.icode-blame-inline', 20000)
    const blameBefore = (
      await cdp.evaluate(`document.querySelector('.icode-blame-inline')?.textContent ?? ''`)
    ).replace(/\u00a0/g, ' ')
    assert(
      blameBefore.includes('SCM Smoke') && blameBefore.includes('Smart commit smoke'),
      `inline blame did not name the commit: ${blameBefore}`
    )
    await waitForSelector('[data-testid="statusbar-blame"]', 10000)
    const statusBlame = (
      await cdp.evaluate(
        `document.querySelector('[data-testid="statusbar-blame"]')?.innerText ?? ''`
      )
    ).replace(/\u00a0/g, ' ')
    assert(
      statusBlame.includes('SCM Smoke') && statusBlame.includes('Smart commit smoke'),
      `status-bar blame did not name the commit: ${statusBlame}`
    )
    await click('[data-testid="editor-blame-toggle"]')
    await waitFor(
      `!document.querySelector('.icode-blame-inline')`,
      'inline blame toggled off',
      5000
    )
    await click('[data-testid="editor-blame-toggle"]')
    await waitForSelector('.icode-blame-inline', 10000)

    await cdp.evaluate(
      `document.querySelector('[data-testid="monaco-editor"]')?.__icodeEditor?.focus()`
    )
    await sleep(250)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2
    })
    await cdp.send('Input.insertText', {
      text: '# Monaco smoke\n\nEdited in the real editor.\n'
    })
    await waitForSelector('[data-testid="editor-dirty"]', 10000)
    await waitFor(
      `(() => { const text = document.querySelector('[data-testid="editor-quick-diff"]')?.textContent ?? ''; return text.length > 0 && text !== ${JSON.stringify(quickBefore)}; })()`,
      'quick diff updated after the edit',
      10000
    )
    const quickAfter = await cdp.evaluate(
      `document.querySelector('[data-testid="editor-quick-diff"]')?.textContent ?? ''`
    )
    assert(
      quickAfter.includes('+') && quickAfter.includes('−'),
      `quick diff did not report additions and deletions: ${quickAfter}`
    )
    await screenshot('15-monaco')
    await waitFor(
      `!document.querySelector('.icode-blame-inline')`,
      'inline blame hidden for unsaved text',
      5000
    )
    await waitFor(
      `!document.querySelector('[data-testid="statusbar-blame"]')`,
      'status-bar blame hidden for unsaved text',
      5000
    )
    await click('[data-testid="editor-save"]')
    await waitFor(
      `!document.querySelector('[data-testid="editor-dirty"]')`,
      'Monaco save',
      10000
    )
    const content = require('node:fs').readFileSync(join(worktreePath, 'README.md'), 'utf8')
    assert(
      content.includes('Edited in the real editor.'),
      `the Monaco edit was not saved: ${content.slice(0, 200)}`
    )
    await waitForSelector('.icode-blame-inline', 15000)
    const blameAfter = (
      await cdp.evaluate(`document.querySelector('.icode-blame-inline')?.textContent ?? ''`)
    ).replace(/\u00a0/g, ' ')
    assert(
      blameAfter.includes('uncommitted'),
      `blame did not update after saving: ${blameAfter}`
    )
    await waitForSelector('[data-testid="statusbar-blame"]', 15000)
    const statusAfter = (
      await cdp.evaluate(
        `document.querySelector('[data-testid="statusbar-blame"]')?.innerText ?? ''`
      )
    ).replace(/\u00a0/g, ' ')
    assert(
      statusAfter.includes('uncommitted'),
      `status-bar blame did not update after saving: ${statusAfter}`
    )
    await screenshot('16-monaco-blame')

    // Quick-diff peek: revert the edit, then redo it and stage it.
    const exec = require('node:child_process').execFileSync
    await click('[data-testid="editor-quick-diff"]')
    await waitForSelector('[data-testid="quick-diff-peek"]', 10000)
    await waitFor(
      `document.querySelector('[data-testid="quick-diff-revert"]') && !document.querySelector('[data-testid="quick-diff-revert"]').disabled`,
      'quick diff actions ready',
      15000
    )
    await screenshot('17-quick-diff-peek')
    await click('[data-testid="quick-diff-revert"]')
    await waitForSelector('[data-testid="quick-diff-revert-confirm"]', 5000)
    await click('[data-testid="quick-diff-revert-confirm"]')
    await waitFor(
      `!document.querySelector('[data-testid="quick-diff-peek"]')`,
      'quick diff peek closed after revert',
      15000
    )
    const restoredReadme = require('node:fs').readFileSync(join(worktreePath, 'README.md'), 'utf8')
    const headReadme = exec('git', ['-C', worktreePath, 'show', 'HEAD:README.md'], {
      encoding: 'utf8'
    })
    assert(restoredReadme === headReadme, 'quick-diff revert did not restore the file')
    await waitFor(
      `!document.querySelector('[data-testid="editor-dirty"]')`,
      'revert refreshed the editor buffer',
      10000
    )

    await cdp.evaluate(
      `document.querySelector('[data-testid="monaco-editor"]')?.__icodeEditor?.focus()`
    )
    await sleep(250)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2
    })
    await cdp.send('Input.insertText', {
      text: '# Monaco smoke\n\nEdited in the real editor.\n'
    })
    await waitForSelector('[data-testid="editor-dirty"]', 10000)
    await click('[data-testid="editor-save"]')
    await waitFor(
      `!document.querySelector('[data-testid="editor-dirty"]')`,
      'second Monaco save',
      10000
    )
    await waitFor(
      `document.querySelector('[data-testid="editor-quick-diff"]') && !document.querySelector('[data-testid="editor-quick-diff"]').disabled`,
      'quick diff badge enabled again',
      10000
    )
    await click('[data-testid="editor-quick-diff"]')
    await waitForSelector('[data-testid="quick-diff-peek"]', 10000)
    await waitFor(
      `document.querySelector('[data-testid="quick-diff-stage"]') && !document.querySelector('[data-testid="quick-diff-stage"]').disabled`,
      'quick diff stage ready',
      15000
    )
    await click('[data-testid="quick-diff-stage"]')
    await waitFor(
      `document.querySelector('[data-testid="quick-diff-peek-status"]')?.innerText.includes('Staged this change')`,
      'quick diff stage result',
      20000
    )
    const cachedReadme = exec('git', ['-C', worktreePath, 'diff', '--cached', '--', 'README.md'], {
      encoding: 'utf8'
    })
    assert(
      cachedReadme.includes('Edited in the real editor.'),
      'quick-diff Stage Change did not stage the edit'
    )
    await screenshot('17a-quick-diff-stage')
  })

  await step('honors protected branches from Settings', async () => {
    await click('[data-testid="rail-settings"]')
    await waitForSelector('[data-testid="scm-setting-branch-protection"]', 15000)
    await setValue('[data-testid="scm-setting-branch-protection"]', '*')
    await cdp.evaluate(`(() => {
      const element = document.querySelector('[data-testid="scm-setting-branch-protection"]');
      if (!element) return false;
      element.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`)
    const stored = await cdp.evaluate(
      `(() => { try { return JSON.parse(window.localStorage.getItem('icode.scm.settings.v1') ?? 'null') } catch { return null } })()`
    )
    assert(stored?.branchProtection?.includes('*'), 'the protection pattern was not persisted')
    await reopenSession()
    await openChanges()
    await waitForSelector('[data-testid="scm-protected-branch"]', 15000)
    await setValueRetry('[data-testid="git-commit-message"]', 'Protected smoke')
    await click('[data-testid="git-commit"]')
    await waitForNotice('protected by Settings', 15000)

    await click('[data-testid="rail-settings"]')
    await waitForSelector('[data-testid="scm-setting-branch-protection"]', 10000)
    await setValue('[data-testid="scm-setting-branch-protection"]', '')
    await cdp.evaluate(`(() => {
      const element = document.querySelector('[data-testid="scm-setting-branch-protection"]');
      if (!element) return false;
      element.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`)
    await reopenSession()
    await openChanges()
    await waitFor(
      `!document.querySelector('[data-testid="scm-protected-branch"]')`,
      'protected branch warning cleared',
      10000
    )
  })

  await quit()
  RUN.finishedAt = new Date().toISOString()
  RUN.status = RUN.failures.length === 0 ? 'passed' : 'failed'
  writeFileSync(join(ARTIFACT_DIR, 'scm-smoke.json'), JSON.stringify(RUN, null, 2))
  log(`evidence: ${join(ARTIFACT_DIR, 'scm-smoke.json')}`)
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
  writeFileSync(join(ARTIFACT_DIR, 'scm-smoke.json'), JSON.stringify(RUN, null, 2))
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
  log(`evidence: ${join(ARTIFACT_DIR, 'scm-smoke.json')}`)
  process.exitCode = 1
})
