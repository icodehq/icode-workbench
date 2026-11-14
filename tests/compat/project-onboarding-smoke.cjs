'use strict'

/**
 * Real-Electron acceptance for the adaptive Add project flow.
 *
 * A folder that is not versioned yet must become usable without sending the user
 * to a terminal or keeping the dialog open for the first commit. Add project
 * registers it, starts background preparation, and the project becomes ready
 * without a modal spinner.
 */

const { execFileSync, spawn } = require('node:child_process')
const { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const ELECTRON = require('electron')
const ARTIFACT_DIR = join(APP_DIR, 'artifacts', 'project-onboarding-smoke')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'icode-project-onboarding-'))
const USER_DATA = join(RUN_DIR, 'userdata')
const FOLDER = join(RUN_DIR, 'plain-project')
const PARENT = join(RUN_DIR, 'repo-parent')
const CHILD = join(PARENT, 'child')
const CLONE_SOURCE = join(RUN_DIR, 'clone-source')
const CLONE_PARENT = join(RUN_DIR, 'clone-parent')
const PORT = 25_100 + (process.pid % 400)

const RUN = {
  startedAt: new Date().toISOString(),
  runDir: RUN_DIR,
  steps: [],
  failures: [],
  artifacts: []
}

let appProcess = null
let cdp = null

mkdirSync(ARTIFACT_DIR, { recursive: true })
mkdirSync(FOLDER, { recursive: true })
writeFileSync(join(FOLDER, 'README.md'), '# Plain project\n')
writeFileSync(join(FOLDER, 'app.ts'), 'export const value = 1\n')
mkdirSync(join(FOLDER, 'node_modules', 'fixture'), { recursive: true })
writeFileSync(join(FOLDER, 'node_modules', 'fixture', 'index.js'), 'dependency\n')
mkdirSync(CHILD, { recursive: true })
writeFileSync(join(PARENT, 'notes.txt'), 'container\n')
writeFileSync(join(CHILD, 'README.md'), '# child\n')
execFileSync('git', ['init', '-q', '-b', 'main', CHILD])
execFileSync('git', ['-C', CHILD, 'config', 'user.name', 'Child Smoke'])
execFileSync('git', ['-C', CHILD, 'config', 'user.email', 'child@smoke.test'])
execFileSync('git', ['-C', CHILD, 'add', 'README.md'])
execFileSync('git', ['-C', CHILD, 'commit', '-qm', 'child baseline'])

// A real local repository to clone from, and its destination parent.
mkdirSync(CLONE_SOURCE, { recursive: true })
mkdirSync(CLONE_PARENT, { recursive: true })
writeFileSync(join(CLONE_SOURCE, 'README.md'), '# clone source\n')
execFileSync('git', ['init', '-q', '-b', 'main', CLONE_SOURCE])
execFileSync('git', ['-C', CLONE_SOURCE, 'config', 'user.name', 'Clone Smoke'])
execFileSync('git', ['-C', CLONE_SOURCE, 'config', 'user.email', 'clone@smoke.test'])
execFileSync('git', ['-C', CLONE_SOURCE, 'add', 'README.md'])
execFileSync('git', ['-C', CLONE_SOURCE, 'commit', '-qm', 'clone baseline'])

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}
function log(message) {
  process.stdout.write(`[project-onboarding] ${message}\n`)
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
  } catch (error) {
    RUN.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}
async function waitFor(expression, description, timeoutMs = 25_000) {
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
async function waitForSelector(selector, timeoutMs = 25_000) {
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
async function setValue(selector, value) {
  const applied = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const proto = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  assert(applied, `Could not set ${selector}`)
}
async function screenshot(name) {
  if (!cdp) return
  const path = join(ARTIFACT_DIR, `${name}.png`)
  await cdp.screenshot(path)
  RUN.artifacts.push(path)
}

async function launch() {
  const logPath = join(ARTIFACT_DIR, 'app.log')
  const logStream = createWriteStream(logPath)
  RUN.artifacts.push(logPath)
  appProcess = spawn(ELECTRON, ['.', `--remote-debugging-port=${String(PORT)}`], {
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
  cdp = await connect(PORT)
  await waitForSelector('[data-testid="workspace-sidebar"]', 30_000)
  await waitFor(
    `Boolean(document.querySelector('[data-testid="empty-workspace"]'))`,
    'the empty workspace',
    30_000
  )
}
async function quit() {
  try {
    await cdp?.evaluate('window.close()')
  } catch {}
  await Promise.race([
    new Promise((done) => appProcess?.once('exit', done)),
    sleep(6000)
  ])
  if (appProcess && appProcess.exitCode === null) appProcess.kill('SIGTERM')
  try {
    cdp?.close()
  } catch {}
  cdp = null
  appProcess = null
  const metaPath = join(USER_DATA, 'run', 'meta.json')
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (typeof meta.pid === 'number') process.kill(meta.pid, 'SIGTERM')
  } catch {}
}

async function main() {
  await launch()
  let addReturnedMs = 0
  await step('add a non-Git folder without waiting for its first commit', async () => {
    const startedAt = Date.now()
    await click('[data-testid="empty-add-repo"]')
    await waitForSelector('[data-testid="add-repo-form"]')
    await setValue('[data-testid="add-repo-input"]', FOLDER)
    await click('[data-testid="add-repo-submit"]')

    /*
     * With a configured Git identity the first click prepares immediately and
     * closes the dialog. Without one, the dialog must stop for the identity
     * fields; that is the only remaining decision.
     */
    const decision = await waitFor(
      `(() => {
        if (document.querySelector('[data-testid="add-repo-adoption"]')) return 'adoption';
        if (document.querySelector('[data-testid="sessions-surface"]') || document.querySelector('[data-testid^="project-row-"]')) return 'sessions';
        return '';
      })()`,
      'the initialization decision',
      20_000
    )
    if (decision === 'identity' || decision === 'adoption') {
      const text = await cdp.evaluate(
        `document.querySelector('[data-testid="add-repo-adoption"]')?.innerText ?? ''`
      )
      assert(
        text.includes('Initialize Git') || text.includes('Create the first commit'),
        'The adoption panel did not explain the first-commit step'
      )
      assert(
        !(await cdp.evaluate(
          `Boolean(document.querySelector('[data-testid="add-repo-preview"]'))`
        )),
        'The removed recursive preview is still gating the dialog'
      )
      await screenshot('01-initialize-decision')
      if (decision === 'identity') {
        await setValue('[data-testid="add-repo-identity-name"]', 'Onboarding Smoke')
        await setValue('[data-testid="add-repo-identity-email"]', 'onboarding@smoke.test')
        await click('[data-testid="add-repo-submit"]')
      }
      await waitForSelector('[data-testid="sessions-surface"]', 30_000)
    }

    addReturnedMs = Date.now() - startedAt
    assert(
      await cdp.evaluate(`Boolean(document.querySelector('[data-testid^="project-row-"]'))`),
      'The initialized project did not appear on the wall'
    )
    assert(existsSync(join(FOLDER, '.git')), 'The folder was not initialized as a Git repository')
    return { addReturnedMs }
  })

  await step('finish the first commit in the background and skip dependencies', async () => {
    await waitFor(
      `(async () => {
        const result = await window.icode.repos.list();
        return result.ok && result.value.some((repo) =>
          repo.path === ${JSON.stringify(FOLDER)} && repo.preparation?.state === 'ready'
        );
      })()`,
      'the first commit to become ready',
      90_000
    )
    const subject = execFileSync('git', ['-C', FOLDER, 'log', '-1', '--pretty=%s'], {
      encoding: 'utf8'
    }).trim()
    assert(subject === 'Initial commit', `Unexpected first commit: ${subject}`)
    const tracked = execFileSync('git', ['-C', FOLDER, 'ls-files'], { encoding: 'utf8' })
    assert(tracked.includes('README.md'), 'The first commit did not track the existing files')
    assert(!tracked.includes('node_modules'), 'The first commit staged node_modules')
    const ignore = readFileSync(join(FOLDER, '.gitignore'), 'utf8')
    assert(ignore.includes('node_modules/'), 'The background flow did not create .gitignore')
    return {
      addReturnedMs,
      subject,
      tracked: tracked.trim().split('\n').filter(Boolean).length
    }
  })

  await step('offer child repositories when the selected folder is only a container', async () => {
    await click('[data-testid="sidebar-add-project"]')
    await waitForSelector('[data-testid="add-repo-form"]')
    await setValue('[data-testid="add-repo-input"]', PARENT)
    await click('[data-testid="add-repo-submit"]')
    await waitForSelector('[data-testid="add-repo-adoption"]', 20_000)
    assert(
      await cdp.evaluate(`Boolean(document.querySelector('[data-testid="add-repo-candidate-0"]'))`),
      'The parent folder did not offer its child repository'
    )
    await screenshot('02-child-repositories')
    await click('[data-testid="add-repo-candidate-0"]')
    await waitForSelector('[data-testid="sessions-surface"]', 30_000)
    await waitFor(
      `document.querySelectorAll('[data-testid^="project-row-"]').length === 2`,
      'two registered projects',
      20_000
    )
    const repos = await cdp.evaluate(`(async () => {
      const result = await window.icode.repos.list();
      return result.ok ? result.value.map((repo) => repo.path) : result;
    })()`)
    assert(Array.isArray(repos) && repos.includes(CHILD), 'The child repository was not registered')
    assert(!existsSync(join(PARENT, '.git')), 'The parent folder was initialized instead of offered children')
    return { repos }
  })

  await step('clone a repository from a URL with progress', async () => {
    await click('[data-testid="sidebar-add-project"]')
    await waitForSelector('[data-testid="add-repo-form"]')
    await click('[data-testid="add-repo-mode-clone"]')
    await setValue('[data-testid="add-repo-clone-url"]', CLONE_SOURCE)
    await setValue('[data-testid="add-repo-clone-parent"]', CLONE_PARENT)
    const suggestedName = await cdp.evaluate(
      `document.querySelector('[data-testid="add-repo-clone-name"]')?.value ?? null`
    )
    assert(suggestedName === 'clone-source', `unexpected clone name: ${suggestedName}`)
    await screenshot('03-clone-form')
    await click('[data-testid="add-repo-submit"]')
    await waitFor(
      `!document.querySelector('[data-testid="add-repo-form"]')`,
      'the clone dialog to close',
      60_000
    )
    const destination = join(CLONE_PARENT, 'clone-source')
    assert(existsSync(join(destination, 'README.md')), 'the clone did not create its checkout')
    await waitFor(
      `(async () => {
        const result = await window.icode.repos.list();
        return result.ok && result.value.some((repo) => repo.path === ${JSON.stringify(destination)});
      })()`,
      'the cloned repository to be registered',
      30_000
    )
  })

  await step('add, fetch and remove a remote from Repository settings', async () => {
    const repo = await cdp.evaluate(`(async () => {
      const result = await window.icode.repos.list();
      return result.ok
        ? result.value.find((entry) => entry.path === ${JSON.stringify(FOLDER)}) ?? null
        : null;
    })()`)
    assert(repo && typeof repo.id === 'string', 'the plain project is missing')
    await click(`[data-testid="sidebar-project-menu-${repo.id}"]`)
    await waitForSelector('[data-testid="sidebar-project-menu"]', 10_000)
    await click(`[data-testid="repository-settings-${repo.id}"]`)
    await waitForSelector('[data-testid="repository-settings-dialog"]', 10_000)
    await waitForSelector('[data-testid="remotes-empty"]', 10_000)

    await click('[data-testid="remote-add"]')
    await setValue('[data-testid="remote-form-name"]', 'origin')
    await setValue('[data-testid="remote-form-url"]', CLONE_SOURCE)
    await click('[data-testid="remote-form-save"]')
    await waitForSelector('[data-testid="remote-row-origin"]', 15_000)

    await click('[data-testid="remote-fetch-origin"]')
    await waitForSelector('[data-testid="remotes-notice"]', 15_000)

    await click('[data-testid="remote-remove-origin"]')
    await waitForSelector('[data-testid="remote-remove-confirm-origin"]', 10_000)
    await click('[data-testid="remote-remove-commit-origin"]')
    await waitFor(
      `!document.querySelector('[data-testid="remote-row-origin"]')`,
      'the remote to be removed',
      15_000
    )
    await waitForSelector('[data-testid="remotes-empty"]', 10_000)
    await click('[data-testid="repository-settings-close"]')
  })

  RUN.ok = RUN.failures.length === 0
}

main()
  .catch((error) => {
    RUN.ok = false
    RUN.failures.push(error instanceof Error ? error.message : String(error))
    process.stderr.write(`[project-onboarding] ${RUN.failures.at(-1)}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    await quit()
    RUN.finishedAt = new Date().toISOString()
    const evidence = join(ARTIFACT_DIR, 'project-onboarding-smoke.json')
    writeFileSync(evidence, `${JSON.stringify(RUN, null, 2)}\n`)
    process.stdout.write(`[project-onboarding] evidence: ${evidence}\n`)
    process.stdout.write(`[project-onboarding] status: ${RUN.ok ? 'passed' : 'failed'}\n`)
    process.exit(RUN.ok ? 0 : 1)
  })
