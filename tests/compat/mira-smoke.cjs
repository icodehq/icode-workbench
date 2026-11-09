'use strict'

/**
 * Packaged Mira acceptance.
 *
 * Drives the real packaged app over CDP with an isolated profile and a fake
 * Claude shim. It verifies the rail order, the global thread, one full
 * headless-planning turn, and that the conversation survives a relaunch.
 *
 * Usage:
 *   node tests/compat/mira-smoke.cjs [--dir <win-unpacked>]
 */

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { connect, sleep } = require('./ui-cdp.cjs')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'mira-smoke')

function parseArgs(argv) {
  const index = argv.indexOf('--dir')
  return index === -1
    ? path.join(REPO_ROOT, 'dist', 'win-unpacked')
    : path.resolve(argv[index + 1])
}

function findExecutable(dir) {
  for (const name of ['icode.exe', 'iCode.exe']) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function writeFakeHarness(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'claude.cmd'),
    '@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n',
    'utf8'
  )
  fs.writeFileSync(
    path.join(dir, 'fake-claude.js'),
    `'use strict'
if (process.argv.includes('--version')) {
  process.stdout.write('9.9.9\\n')
  process.exit(0)
}
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { prompt += chunk })
process.stdin.on('end', () => {
  const streaming = prompt.includes('Return REAL_OK')
  const markdown = prompt.includes('Return MARKDOWN_OK')
  const fence = String.fromCharCode(96).repeat(3)
  const reply = markdown
    ? [
        '## Status',
        '',
        '- **alpha**',
        '- beta',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        fence + 'ts',
        'const x = 1',
        fence,
        '',
        '[docs](https://example.com)'
      ].join('\\n')
    : streaming
      ? 'REAL_OK'
      : 'FAKE_OK'
  const resultLine = JSON.stringify({
    type: 'result',
    session_id: 'fake-session-1',
    result: JSON.stringify({ reply, actions: [] }),
    is_error: false
  }) + '\\n'
  const resumed = process.argv.includes('--resume')
  if (prompt.includes('Return MARKDOWN_OK') && !resumed) {
    process.stdout.write(JSON.stringify({
      type: 'result',
      session_id: 'fake-session-1',
      result: JSON.stringify({ reply: 'BAD_NO_RESUME', actions: [] }),
      is_error: false
    }) + '\\n')
    return
  }
  if (resumed && prompt.includes('## Recent conversation')) {
    process.stdout.write(JSON.stringify({
      type: 'result',
      session_id: 'fake-session-1',
      result: JSON.stringify({ reply: 'BAD_HISTORY_REPLAY', actions: [] }),
      is_error: false
    }) + '\\n')
    return
  }
  if (!streaming) {
    process.stdout.write(resultLine)
    return
  }
  const event = (text) => JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text }
    }
  }) + '\\n'
  process.stdout.write(event('{"reply":"REAL_'))
  setTimeout(() => {
    process.stdout.write(event('OK","actions":[]}'))
    process.stdout.write(resultLine)
  }, 1200)
})
`,
    'utf8'
  )
}

async function waitFor(cdp, expression, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression)
      if (last) return last
    } catch (error) {
      last = error.message
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for ${description} (last: ${JSON.stringify(last)})`)
}

function launch(executable, work, profile, fakeBin, port) {
  const child = spawn(executable, [`--remote-debugging-port=${String(port)}`], {
    cwd: work,
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      ICODE_GATE_USER_DATA: profile,
      ICODE_BACKGROUND_LAUNCH: '0'
    },
    // The detached Host inherits stdio and outlives the app by design. Ignoring
    // it here keeps a CI pipe open after the smoke finishes.
    stdio: ['ignore', 'ignore', 'ignore']
  })
  return child
}

/**
 * The terminal Host is intentionally detached from the app and would keep the
 * temporary profile's database open. A smoke run owns only the packaged
 * executable, so it can stop the Host whose command line is that package's
 * `out/host/index.js`, without touching an installed iCode.
 */
function stopDetachedHosts(executable) {
  const escaped = executable.replace(/'/g, "''")
  const script =
    `Get-CimInstance Win32_Process | ` +
    `Where-Object { $_.ExecutablePath -eq '${escaped}' -and $_.CommandLine -like '*out\\host\\index.js*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch {
    // Best effort: cleanup must not turn a passing UI check into a failure.
  }
}

async function stop(child, executable) {
  try {
    child.kill()
  } catch {
    // Already gone.
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  await sleep(500)
  stopDetachedHosts(executable)
}

async function openMira(cdp) {
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="app-rail"]'))`,
    'app rail'
  )
  await cdp.evaluate(
    `document.querySelector('[data-testid="rail-assistant"]').click()`
  )
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="assistant-view"]'))`,
    'assistant view'
  )
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="assistant-thread"]').innerText.includes("Hi, I'm Mira")`,
    'Mira welcome'
  )
}

async function main() {
  const packagedDir = parseArgs(process.argv.slice(2))
  const executable = findExecutable(packagedDir)
  if (executable === null) {
    throw new Error(`no packaged executable in ${packagedDir}; run "pnpm package:win" first`)
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'icode-mira-smoke-'))
  const profile = path.join(work, 'profile')
  const fakeBin = path.join(work, 'fake-bin')
  const port = 9800 + (process.pid % 150)
  fs.mkdirSync(profile, { recursive: true })
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFakeHarness(fakeBin)

  let child = launch(executable, work, profile, fakeBin, port)
  let cdp = await connect(port)
  try {
    await openMira(cdp)

    const order = await cdp.evaluate(`(() => {
      const wanted = new Set(['rail-projects', 'rail-schedules', 'rail-assistant', 'rail-settings', 'rail-divider']);
      return Array.from(document.querySelectorAll('[data-testid="app-rail"] [data-testid]'))
        .map((element) => element.dataset.testid)
        .filter((id) => wanted.has(id));
    })()`)
    assert(
      JSON.stringify(order) ===
        JSON.stringify([
          'rail-projects',
          'rail-schedules',
          'rail-divider',
          'rail-assistant',
          'rail-divider',
          'rail-settings'
        ]),
      `unexpected rail order: ${JSON.stringify(order)}`
    )

    const welcome = await cdp.evaluate(
      `document.querySelector('[data-testid="assistant-thread"]').innerText`
    )
    assert(welcome.includes("Hi, I'm Mira"), 'the welcome message is missing')

    await cdp.evaluate(`(() => {
      const element = document.querySelector('[data-testid="assistant-composer"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(element, 'Return REAL_OK');
      element.dispatchEvent(new Event('input', { bubbles: true }));
      return element.value;
    })()`)
    await cdp.evaluate(`document.querySelector('[data-testid="assistant-send"]').click()`)

    // The fake harness pauses between deltas, so the live bubble must appear
    // before the process exits and the durable message is appended.
    await waitFor(
      cdp,
      `Boolean(document.querySelector('[data-testid="assistant-live-draft"]'))`,
      'the streaming draft',
      30_000
    )
    const draft = await cdp.evaluate(
      `document.querySelector('[data-testid="assistant-live-draft"]').innerText`
    )
    assert(draft.includes('REAL_'), `streaming draft was incomplete: ${JSON.stringify(draft)}`)
    await cdp.screenshot(path.join(ARTIFACT_DIR, 'assistant-streaming.png'))

    // The user's own text also contains REAL_OK, so the reply is the third
    // message (welcome + user + assistant), not merely an occurrence in the DOM.
    await waitFor(
      cdp,
      `document.querySelectorAll('[data-testid^="assistant-message-"]').length >= 3`,
      'the assistant reply',
      60_000
    )
    const body = await cdp.evaluate('document.body.innerText')
    assert(body.includes('REAL_OK'), 'the assistant reply is missing REAL_OK')
    assert(!body.includes('could not finish'), 'the assistant turn failed')

    await waitFor(
      cdp,
      `(document.querySelector('[data-testid="assistant-conversation-select"]')?.textContent ?? '').includes('Current conversation')`,
      'the conversation selector',
      30_000
    )

    await cdp.screenshot(path.join(ARTIFACT_DIR, 'assistant.png'))

    await cdp.evaluate(`(() => {
      const element = document.querySelector('[data-testid="assistant-composer"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(element, 'Return MARKDOWN_OK');
      element.dispatchEvent(new Event('input', { bubbles: true }));
      return element.value;
    })()`)
    await cdp.evaluate(`document.querySelector('[data-testid="assistant-send"]').click()`)
    await waitFor(
      cdp,
      `document.querySelectorAll('[data-testid^="assistant-message-"]').length >= 5`,
      'the markdown reply',
      60_000
    )
    const rendered = await cdp.evaluate(`(() => {
      const messages = Array.from(document.querySelectorAll('[data-testid^="assistant-message-"]'));
      const last = messages[messages.length - 1];
      return {
        h2: last.querySelector('h2')?.textContent ?? null,
        headers: last.querySelectorAll('table th').length,
        cells: last.querySelectorAll('table td').length,
        items: last.querySelectorAll('li').length,
        code: last.querySelector('pre code')?.textContent ?? null,
        bold: last.querySelector('strong')?.textContent ?? null,
        link: last.querySelector('a')?.getAttribute('href') ?? null
      };
    })()`)
    assert(rendered.h2 === 'Status', `markdown heading missing: ${JSON.stringify(rendered)}`)
    assert(rendered.headers === 2 && rendered.cells === 2, 'markdown table did not render')
    assert(rendered.items === 2, 'markdown list did not render')
    assert(rendered.code === 'const x = 1', 'markdown code block did not render')
    assert(rendered.bold === 'alpha', 'markdown bold did not render')
    assert(rendered.link === 'https://example.com', 'markdown link did not render')
    await cdp.screenshot(path.join(ARTIFACT_DIR, 'assistant-markdown.png'))

    await cdp.evaluate(`document.querySelector('[data-testid="rail-projects"]').click()`)
    await waitFor(
      cdp,
      `Boolean(document.querySelector('[data-testid="projects-wall"]')) || Boolean(document.querySelector('[data-testid="empty-workspace"]'))`,
      'workspace after leaving Mira'
    )

    await cdp.evaluate(`document.querySelector('[data-testid="rail-settings"]').click()`)
    await waitFor(
      cdp,
      `Boolean(document.querySelector('[data-testid="settings-view"]'))`,
      'settings view'
    )
    await waitFor(
      cdp,
      `Boolean(document.querySelector('[data-testid="settings-mira-target"]'))`,
      'Mira target setting'
    )
    const targets = await cdp.evaluate(`(() => {
      const select = document.querySelector('[data-testid="settings-mira-target"]');
      return Array.from(select.options).map((option) => option.textContent);
    })()`)
    assert(
      targets.some((label) => label.includes('This computer')),
      `Mira target options are incomplete: ${JSON.stringify(targets)}`
    )
    await cdp.screenshot(path.join(ARTIFACT_DIR, 'settings.png'))
  } finally {
    try {
      cdp.close()
    } catch {
      // Ignore.
    }
    await stop(child, executable)
  }

  // Relaunch the same profile: the thread and its messages must survive.
  // A fresh port avoids racing the previous instance's CDP listener during
  // shutdown.
  await sleep(1_000)
  child = launch(executable, work, profile, fakeBin, port + 1)
  cdp = await connect(port + 1)
  try {
    await openMira(cdp)
    await waitFor(
      cdp,
      `document.querySelector('[data-testid="assistant-thread"]').innerText.includes('REAL_OK')`,
      'the persisted assistant reply'
    )
    await cdp.screenshot(path.join(ARTIFACT_DIR, 'assistant-restart.png'))
  } finally {
    try {
      cdp.close()
    } catch {
      // Ignore.
    }
    await stop(child, executable)
    fs.rmSync(work, { recursive: true, force: true })
  }

  process.stdout.write(`[mira-smoke] PASS ${executable}\n`)
}

main().catch((error) => {
  process.stderr.write(`[mira-smoke] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
