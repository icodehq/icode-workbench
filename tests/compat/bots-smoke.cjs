'use strict'

/**
 * Bots-room acceptance.
 *
 * Boots the real Electron app against an isolated profile, creates two bots and
 * a group through IPC, then drives the sidebar, room composer, thread strip,
 * settings dialogs and pause control through the rendered UI. No harness run is
 * needed: the group starts in mention-only mode, so the message is stored
 * without waking a model.
 *
 * Usage: node tests/compat/bots-smoke.cjs
 */

const { spawn } = require('node:child_process')
const { createWriteStream, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { connect, allocatePort } = require('./ui-cdp.cjs')

const APP_DIR = resolve(__dirname, '..', '..')
const ELECTRON = require('electron')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'icode-bots-smoke-'))
const USER_DATA = join(RUN_DIR, 'userdata')
const HOST_DIR = join(RUN_DIR, 'host')
const SOCKET = join(HOST_DIR, 'terminal-host.sock')
const ARTIFACT_DIR = join(APP_DIR, 'artifacts', 'bots-smoke')

let appProcess = null
let cdp = null
const artifacts = []
const steps = []

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function log(message) {
  process.stdout.write(`[bots-smoke] ${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitFor(expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(expression)) return
    } catch {
      // The window can be mid-navigation; retry.
    }
    await sleep(150)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function step(name, work) {
  log(name)
  const started = Date.now()
  await work()
  steps.push({ name, ms: Date.now() - started })
}

async function screenshot(name) {
  const path = join(ARTIFACT_DIR, `${name}.png`)
  await cdp.screenshot(path)
  artifacts.push(path)
}

async function launch(port) {
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFileSync(join(USER_DATA, 'preferences.json'), '{"locale":"en"}\n')
  const logPath = join(ARTIFACT_DIR, 'app.log')
  const logStream = createWriteStream(logPath)
  artifacts.push(logPath)
  appProcess = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      ICODE_GATE_USER_DATA: USER_DATA,
      ICODE_BACKGROUND_LAUNCH: '0',
      ICODE_HOST_DIR: HOST_DIR,
      ...(process.platform === 'win32' ? {} : { ICODE_HOST_SOCKET: SOCKET })
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  appProcess.stdout.pipe(logStream)
  appProcess.stderr.pipe(logStream)
  appProcess.on('exit', (code, signal) => {
    log(`app ${code === 0 ? 'exited' : 'failed'} code=${code} signal=${signal}`)
  })
  appProcess.on('error', (error) => {
    log(`app spawn error: ${String(error)}`)
  })
  cdp = await connect(port)
  await cdp.send('Runtime.enable')
  cdp.ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data))
      if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params?.exceptionDetails
        log(
          `renderer exception: ${
            detail?.exception?.description ?? detail?.text ?? 'unknown'
          }`
        )
      }
      if (message.method === 'Inspector.targetCrashed') {
        log('renderer target crashed')
      }
    } catch {
      // Non-JSON or unrelated CDP traffic.
    }
  })
  await waitFor(
    `Boolean(document.querySelector('[data-testid="workspace-sidebar"]'))`,
    'workspace sidebar',
    30000
  )
  await waitFor(
    `!document.body.innerText.includes('Loading repositories')`,
    'workspace boot',
    30000
  )
}

async function quit() {
  if (!cdp) {
    if (appProcess && appProcess.exitCode === null) appProcess.kill('SIGTERM')
    return
  }
  try {
    await cdp.evaluate('window.close()')
  } catch {
    // The page disappears before the response arrives.
  }
  await Promise.race([
    new Promise((done) => appProcess.once('exit', done)),
    sleep(5000)
  ])
  if (appProcess && appProcess.exitCode === null) appProcess.kill('SIGTERM')
  try {
    cdp.close()
  } catch {}
}

async function main() {
  const port = await allocatePort()
  await launch(port)

  let botId = ''
  let groupId = ''
  await step('start with an empty Bots roster and a template entry point', async () => {
    await waitFor(
      `Boolean(document.querySelector('[data-testid="sidebar-bots"]'))`,
      'Bots section'
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="sidebar-bots-empty-new"]'))`,
      'empty Bots onboarding'
    )
    assert(
      (await cdp.evaluate(
        `document.querySelectorAll('[data-testid^="sidebar-bots-bot-"]').length`
      )) === 0,
      'Expected no pre-installed bot rows'
    )
    await screenshot('00-empty-bots')
    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-bots-empty-new"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="new-bot-dialog"]'))`,
      'template picker from the empty roster'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="new-bot-template-pr-review"]').click()`
    )
    await waitFor(
      `document.querySelector('[data-testid="new-bot-name"]')?.value === 'Pull request review'`,
      'first-run template prefill'
    )
    assert(
      (await cdp.evaluate(
        `document.querySelector('[data-testid="new-bot-target"]')?.value`
      )) === 'auto',
      'Expected the New Bot target to default to Auto'
    )
    await cdp.evaluate(`(() => {
      const select = document.querySelector('[data-testid="new-bot-target"]')
      select.value = 'local'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await waitFor(
      `document.querySelector('[data-testid="new-bot-target"]')?.value === 'local'`,
      'New Bot target selection'
    )
    assert(
      (await cdp.evaluate(
        `document.querySelectorAll('[data-testid^="new-bot-template-"]:not([data-testid="new-bot-template-search"])').length`
      )) === 26,
      'Expected 25 templates and a blank option on first run'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="new-bot-template-chief-of-staff"]').click()`
    )
    await waitFor(
      `document.querySelector('[data-testid="new-bot-name"]')?.value === 'Yarcy' && document.querySelector('[data-testid="new-bot-role"]')?.value === 'Chief of Staff'`,
      'chief of staff template prefill'
    )
    await screenshot('00b-templates')
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="new-bot-dialog"] button')).find((button) => button.textContent.includes('Cancel')).click()`
    )
    await waitFor(
      `!document.querySelector('[data-testid="new-bot-dialog"]')`,
      'template picker closed'
    )
  })
  await step('create two bots and a mention-only group', async () => {
    const created = await cdp.evaluate(`(async () => {
      const first = await window.icode.bots.create({
        name: 'Probe',
        role: 'Engineer',
        harness: 'claude'
      })
      if (!first.ok) throw new Error(first.error.message)
      const second = await window.icode.bots.create({
        name: 'Checker',
        role: 'Reviewer',
        harness: 'claude'
      })
      if (!second.ok) throw new Error(second.error.message)
      const group = await window.icode.groups.create({
        name: 'Probe Group',
        memberBotIds: [first.value.id, second.value.id]
      })
      if (!group.ok) throw new Error(group.error.message)
      const revised = await window.icode.groups.update({
        groupId: group.value.id,
        revision: group.value.revision,
        replyMode: { kind: 'mentions' }
      })
      if (!revised.ok) throw new Error(revised.error.message)
      return { first: first.value.id, second: second.value.id, group: group.value.id }
    })()`)
    botId = created.first
    groupId = created.group
    await waitFor(
      `Boolean(document.querySelector('[data-testid="sidebar-bots-group-${groupId}"]'))`,
      'group row in the main sidebar'
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="sidebar-bots-bot-${botId}"]'))`,
      'bot row in the main sidebar'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="sidebar-bots-search"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set
      setter.call(input, 'zzz-no-match')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(
      `document.body.innerText.includes('No matches.')`,
      'sidebar search empty state'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="sidebar-bots-search"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="sidebar-bots-group-${groupId}"]'))`,
      'group row after clearing search'
    )
    await cdp.evaluate(`(() => {
      const source = document.querySelector(
        '[data-testid="sidebar-bots-bot-${botId}"]'
      )
      const target = document.querySelector(
        '[data-testid="sidebar-bots-group-${groupId}"]'
      )
      const transfer = new DataTransfer()
      source.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer })
      )
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientY: rect.top + 1
        })
      )
      target.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientY: rect.top + 1
        })
      )
      source.dispatchEvent(
        new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: transfer })
      )
      return true
    })()`)
    await waitFor(
      `(() => {
        const order = JSON.parse(
          localStorage.getItem('icode.bots.row-order.v1') || '[]'
        )
        return order.indexOf('bot:${botId}') >= 0 &&
          order.indexOf('bot:${botId}') < order.indexOf('group:${groupId}')
      })()`,
      'bots manual order'
    )
    await cdp.evaluate(`(() => {
      const row = document.querySelector(
        '[data-testid="sidebar-bots-group-${groupId}"]'
      )
      const rect = row.getBoundingClientRect()
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 24,
          clientY: rect.top + 8
        })
      )
      return true
    })()`)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-row-menu"]'))`,
      'bots row menu'
    )
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="bots-row-menu"] [role="menuitem"]')).find((item) => item.textContent.includes('Group settings')).click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="group-settings-dialog"]'))`,
      'group settings from the row menu'
    )
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="group-settings-dialog"] button')).find((button) => button.textContent.trim() === 'Cancel').click()`
    )
    await waitFor(
      `!document.querySelector('[data-testid="group-settings-dialog"]')`,
      'group settings closed'
    )
    await cdp.evaluate(`(() => {
      const handle = document.querySelector('[data-testid="sidebar-bots-resize"]')
      const rect = handle.getBoundingClientRect()
      const init = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientY: rect.top + 4
      }
      handle.dispatchEvent(new PointerEvent('pointerdown', init))
      window.dispatchEvent(
        new PointerEvent('pointermove', { ...init, clientY: rect.top + 36 })
      )
      window.dispatchEvent(
        new PointerEvent('pointerup', { ...init, clientY: rect.top + 36 })
      )
      return true
    })()`)
    await waitFor(
      `Number(localStorage.getItem('icode.bots.section-height.v1')) > 0`,
      'resized Bots section'
    )
    await cdp.evaluate(`(() => {
      const handle = document.querySelector('[data-testid="sidebar-bots-resize"]')
      handle.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      )
      return true
    })()`)
    await waitFor(
      `localStorage.getItem('icode.bots.section-height.v1') === null`,
      'Bots section reset'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-bots-options"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-options-menu"]'))`,
      'bot options menu'
    )
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="bots-options-menu"] [role="menuitem"]')).find((item) => item.textContent.includes('Agent activity')).click()`
    )
    await waitFor(
      `JSON.parse(localStorage.getItem('icode.bots.view.v1') || '{}').sortBy === 'smart'`,
      'smart bot sort'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-bots-options"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-options-menu"]'))`,
      'bot options menu again'
    )
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="bots-options-menu"] [role="menuitem"]')).find((item) => item.textContent.trim() === 'Manual').click()`
    )
    await waitFor(
      `JSON.parse(localStorage.getItem('icode.bots.view.v1') || '{}').sortBy === 'manual'`,
      'manual bot sort'
    )
    await cdp.evaluate(`(() => {
      const row = document.querySelector('[data-testid="sidebar-bots-bot-${botId}"]')
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }))
      return true
    })()`)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-hover-card"]'))`,
      'bots hover card',
      3000
    )
    await screenshot('01a-bots-hover')
    await cdp.evaluate(`(() => {
      const row = document.querySelector('[data-testid="sidebar-bots-bot-${botId}"]')
      row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true }))
      return true
    })()`)
    await waitFor(
      `!document.querySelector('[data-testid="bots-hover-card"]')`,
      'bots hover card closed'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-bots"] button[aria-label="Bots"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="sidebar-bots-collapsed-preview"]'))`,
      'collapsed Bots preview'
    )
    await screenshot('01b-bots-collapsed')
    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-bots"] button[aria-label="Bots"]').click()`
    )
    await waitFor(
      `!document.querySelector('[data-testid="sidebar-bots-collapsed-preview"]')`,
      'Bots expanded'
    )
    await cdp.evaluate(`(() => {
      const row = document.querySelector('[data-testid="sidebar-bots-bot-${botId}"]')
      const rect = row.getBoundingClientRect()
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 24,
          clientY: rect.top + 8
        })
      )
      return true
    })()`)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-row-menu"]'))`,
      'bot row menu'
    )
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="bots-row-menu"] [role="menuitem"]')).find((item) => item.textContent.includes('Rename')).click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-rename-bot-${botId}"]'))`,
      'inline bot rename'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="bots-rename-bot-${botId}"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set
      setter.call(input, 'Probe Renamed')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await waitFor(
      `document.querySelector('[data-testid="bots-rename-bot-${botId}"]')?.value === 'Probe Renamed'`,
      'rename draft'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="bots-rename-bot-${botId}"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`
    )
    await waitFor(
      `document.querySelector('[data-testid="sidebar-bots-bot-${botId}"]')?.innerText.includes('Probe Renamed')`,
      'renamed bot row'
    )
    await screenshot('01-sidebar')
    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-bots-new"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="sidebar-bots-new-bot"]'))`,
      'new bot menu'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-bots-new-bot"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="new-bot-dialog"]'))`,
      'new bot dialog'
    )
    assert(
      (await cdp.evaluate(
        `document.querySelectorAll('[data-testid^="new-bot-template-"]:not([data-testid="new-bot-template-search"])').length`
      )) === 26,
      'Expected 25 templates and a blank option'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="new-bot-template-pr-review"]').click()`
    )
    await waitFor(
      `document.querySelector('[data-testid="new-bot-name"]')?.value === 'Pull request review'`,
      'template prefill'
    )
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="new-bot-dialog"] button')).find((button) => button.textContent.trim() === 'Cancel').click()`
    )
    await waitFor(
      `!document.querySelector('[data-testid="new-bot-dialog"]')`,
      'new bot dialog closed'
    )
  })

  await step('open the group room from the main sidebar and send a message', async () => {
    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-bots-group-${groupId}"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-room"]'))`,
      'group room'
    )
    await waitFor(
      `document.body.innerText.includes('Probe Group')`,
      'group room title'
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="room-tabs"]'))`,
      'group room tabs'
    )
    assert(
      await cdp.evaluate(
        `Array.from(document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]')).some((tab) => tab.innerText.includes('Probe Group'))`
      ),
      'The original room did not open as a room tab'
    )
    const compose = async (text) => {
      await cdp.evaluate(`(() => {
        const input = document.querySelector('[data-testid="bots-composer"]')
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        ).set
        setter.call(input, ${JSON.stringify(text)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await waitFor(
        `!document.querySelector('[data-testid="bots-send"]').disabled`,
        'composer ready'
      )
      await cdp.evaluate(
        `document.querySelector('[data-testid="bots-send"]').click()`
      )
    }
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="bots-composer"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set
      setter.call(input, '@')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-mention-menu"]'))`,
      'group mention picker'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="bots-composer"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    const message = 'Hello from the room smoke'
    await compose(message)
    try {
      await waitFor(
        `document.body.innerText.includes(${JSON.stringify(message)})`,
        'sent room message',
        8000
      )
    } catch {
      // A click can race the first paint after the room's async load; one
      // deliberate retry keeps the smoke honest without hiding a UI failure.
      await compose(message)
      await waitFor(
        `document.body.innerText.includes(${JSON.stringify(message)})`,
        'sent room message after retry',
        12000
      )
    }
    await screenshot('02-room')
  })

  await step('open group settings and keep the revisioned group', async () => {
    await cdp.evaluate(
      `document.querySelector('[data-testid="bots-group-settings"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="group-settings-dialog"]'))`,
      'group settings dialog'
    )
    await screenshot('03-group-settings')
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="group-settings-dialog"] button')).find((button) => button.textContent.trim() === 'Cancel').click()`
    )
    await waitFor(
      `!document.querySelector('[data-testid="group-settings-dialog"]')`,
      'group settings closed'
    )
  })

  await step('create a thread, split rooms, and reopen a closed room', async () => {
    await cdp.evaluate(
      `document.querySelector('[data-testid="bots-threads-menu"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-thread-new"]'))`,
      'threads menu'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="bots-thread-new"]').click()`
    )
    await waitFor(
      `document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]').length >= 2`,
      'second room tab'
    )

    const title = 'Smoke thread title'
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="bots-composer"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set
      setter.call(input, ${JSON.stringify(`${title}\nsecond line`)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(
      `!document.querySelector('[data-testid="bots-send"]').disabled`,
      'thread composer ready'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="bots-send"]').click()`
    )
    await waitFor(
      `document.body.innerText.includes(${JSON.stringify(title)})`,
      'thread message',
      8000
    )
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]')).some((tab) => tab.innerText.includes(${JSON.stringify(title)}))`,
      'thread tab titled',
      8000
    )
    assert(
      await cdp.evaluate(
        `document.querySelector('[data-testid="sidebar-bots-group-${groupId}"]')?.innerText.includes(${JSON.stringify(title)})`
      ),
      'The sidebar preview did not follow the newest room'
    )
    await screenshot('03b-thread')

    await cdp.evaluate(
      `document.querySelector('[data-testid="room-tabs-split"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="room-pane-empty"]'))`,
      'split picker'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid^="room-pick-"]').click()`
    )
    await waitFor(
      `document.querySelectorAll('[data-testid="session-split-divider"]').length >= 1`,
      'split divider'
    )
    await waitFor(
      `document.querySelectorAll('[data-testid="bots-room-thread"]').length >= 2`,
      'two room panes'
    )
    await screenshot('03c-split')

    await cdp.evaluate(`(() => {
      const tab = Array.from(
        document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]')
      ).find((entry) => entry.innerText.includes(${JSON.stringify(title)}))
      tab?.parentElement?.querySelector('button[data-testid$="-close"]')?.click()
    })()`)
    await waitFor(
      `document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]').length === 1`,
      'closed room tab'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="bots-threads-menu"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-thread-new"]'))`,
      'threads menu reopened'
    )
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid^="bots-thread-"]:not([data-testid="bots-thread-new"])')).find((item) => item.innerText.includes(${JSON.stringify(title)}))?.click()`
    )
    await waitFor(
      `document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]').length === 2`,
      'reopened room tab'
    )
    await screenshot('03d-reopened')

    await cdp.evaluate(
      `document.querySelector('[data-testid="room-tabs-new"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="room-tabs-new-item"]'))`,
      'tab strip new thread menu'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="room-tabs-new-item"]').click()`
    )
    await waitFor(
      `document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]').length >= 3`,
      'third room tab from the strip'
    )
    await screenshot('03e-third-room')

    const openTabMenu = async () => {
      await cdp.evaluate(`(() => {
        const tab = document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]')[0]
        const rect = tab.getBoundingClientRect()
        tab.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: rect.left + 10,
          clientY: rect.top + 10
        }))
      })()`)
      await waitFor(
        `Boolean(document.querySelector('[data-testid="room-tab-menu"]'))`,
        'room tab menu'
      )
    }
    await openTabMenu()
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent.trim() === 'Rename')?.click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="room-tab-rename"]'))`,
      'room tab rename input'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="room-tab-rename"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set
      setter.call(input, 'Pinned room')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })()`)
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]')).some((tab) => tab.innerText.includes('Pinned room'))`,
      'renamed room tab'
    )

    await openTabMenu()
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent.trim() === 'Pin tab')?.click()`
    )
    await waitFor(
      `!document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]')[0]?.parentElement?.querySelector('button[data-testid$="-close"]')`,
      'pinned room tab'
    )

    await openTabMenu()
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent.trim() === 'Blue')?.click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid$="-color"]'))`,
      'room tab color'
    )
    await cdp.evaluate(`(() => {
      const tab = document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]')[0]
      tab.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })()`)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="room-tab-hover"]'))`,
      'room tab hover card',
      3000
    )
    await cdp.evaluate(`(() => {
      const tab = document.querySelectorAll('[data-testid="room-tabs"] [role="tab"]')[0]
      tab.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    })()`)
    await screenshot('03f-tab-chrome')

    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-bots-history"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-history-dialog"]'))`,
      'room history dialog'
    )
    assert(
      (await cdp.evaluate(
        `document.querySelectorAll('[data-testid^="bots-history-row-"]').length`
      )) >= 3,
      'Room history did not list every room'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="bots-history-close"]').click()`
    )
  })

  await step('open a bot home, pause it, and read its memory tab', async () => {
    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-bots-bot-${botId}"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-open-settings"]'))`,
      'bot settings entry'
    )
    assert(
      await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="bot-home-tab"]'))`
      ),
      'The bot home did not open with a Home tab'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="assistant-composer"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set
      setter.call(input, '@')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(
      `Boolean(document.querySelector('[data-testid="assistant-mention-menu"]'))`,
      'bot mention picker'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="assistant-composer"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await screenshot('03a-bot-home')
    await cdp.evaluate(
      `document.querySelector('[data-testid="bots-open-settings"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bot-settings-dialog"]'))`,
      'bot settings dialog'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="bot-settings-pause"]').click()`
    )
    await waitFor(
      `document.body.innerText.includes('Resume bot')`,
      'paused bot state'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="bot-settings-tab-memory"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bot-memory-pane"]'))`,
      'memory pane'
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="memory-value"]'))`,
      'memory facts loaded'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="memory-value"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set
      setter.call(input, 'Ships on Fridays')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(
      `!document.querySelector('[data-testid="memory-add"]')?.disabled`,
      'memory add ready'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="memory-add"]').click()`
    )
    await waitFor(
      `document.body.innerText.includes('Ships on Fridays')`,
      'the memory fact'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="memory-tab-history"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid^="memory-history-"]'))`,
      'memory history'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid^="memory-undo-"]').click()`
    )
    await waitFor(
      `document.body.innerText.includes('Undone')`,
      'memory undo'
    )
    await screenshot('04-bot-memory')
    await cdp.evaluate(
      `document.querySelector('[data-testid="bot-settings-tab-skills"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bot-skills-pane"]'))`,
      'skills pane'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="skills-new"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="skills-name"]'))`,
      'new skill form'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="skills-name"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set
      setter.call(input, 'release-notes')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const textarea = document.querySelector('[data-testid="skills-text"]')
      const textSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set
      textSetter.call(textarea, '# Release notes\\n\\nHow to write them.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(
      `!document.querySelector('[data-testid="skills-save"]')?.disabled`,
      'skill save ready'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="skills-save"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="skills-row-release-notes"]'))`,
      'saved skill'
    )
    await screenshot('04a-bot-skills')
    await cdp.evaluate(
      `document.querySelector('[data-testid="bot-settings-tab-automations"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bot-automations-pane"]'))`,
      'automations pane'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="automations-new"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="automation-name"]'))`,
      'new automation form'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="automation-name"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set
      setter.call(input, 'Morning check')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const prompt = document.querySelector('[data-testid="automation-prompt"]')
      const textSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set
      textSetter.call(prompt, 'Review the queue.')
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(
      `!document.querySelector('[data-testid="automation-save"]')?.disabled`,
      'automation save ready'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="automation-save"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid^="automation-row-"]'))`,
      'saved automation'
    )
    await screenshot('04b-bot-automations')
    await cdp.evaluate(
      `document.querySelector('[data-testid="bot-settings-tab-agent"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="settings-bot-status"]'))`,
      'bot agent settings'
    )
    await screenshot('05-bot-agent')
    await cdp.evaluate(
      `document.querySelector('[data-testid="app-tab-close-bots-bot:${botId}"]')?.click()`
    )
  })

  await step('open a side chat and reopen it from global history', async () => {
    // The previous step paused the bot; a side chat needs a turn to be named
    // and to appear in global history, so resume it first.
    await cdp.evaluate(
      `document.querySelector('[data-testid="bot-settings-pause"]').click()`
    )
    await waitFor(
      `document.body.innerText.includes('Pause bot')`,
      'resumed bot state'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="bot-settings-close"]').click()`
    )
    await waitFor(
      `!document.querySelector('[data-testid="bot-settings-dialog"]')`,
      'bot settings closed'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="bot-chat-new"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bot-chat-new-menu"]'))`,
      'new chat menu'
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bot-chat-new-menu"] [data-testid^="bot-chat-new-"]:not([aria-disabled="true"])'))`,
      'available agent chat item'
    )
    const pickedHarness = await cdp.evaluate(`(() => {
      const item = document.querySelector(
        '[data-testid="bot-chat-new-menu"] [data-testid^="bot-chat-new-"]:not([aria-disabled="true"])'
      )
      const id = item.getAttribute('data-testid')
      item.click()
      return id.slice('bot-chat-new-'.length)
    })()`)
    await waitFor(
      `document.querySelectorAll('[data-testid^="bot-chat-tab-"]').length >= 1`,
      'side chat tab'
    )
    await waitFor(
      `document.querySelector('[data-testid="bot-chat-header"]')?.getAttribute('data-harness') === ${JSON.stringify(pickedHarness)}`,
      'side chat agent'
    )
    assert(
      await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="bots-open-settings"]'))`
      ),
      'The side chat pane did not render'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="assistant-composer"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set
      setter.call(input, 'Side chat smoke')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(
      `!document.querySelector('[data-testid="assistant-send"]').disabled`,
      'side chat send ready'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="assistant-send"]').click()`
    )
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid^="bot-chat-tab-"]')).some(
        (tab) => tab.textContent.includes('Side chat smoke')
      )`,
      'side chat title'
    )
    const sideChatKey = await cdp.evaluate(
      `document.querySelector('[data-testid^="bot-chat-tab-"]').getAttribute('data-tab-key')`
    )
    assert(typeof sideChatKey === 'string', 'The side chat tab lost its key')
    await screenshot('05a-bot-side-chat')
    await cdp.evaluate(
      `document.querySelector('[data-testid^="bot-chat-close-"]').click()`
    )
    await waitFor(
      `document.querySelectorAll('[data-testid^="bot-chat-tab-"]').length === 0`,
      'side chat closed'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="bots-open-history"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="session-history"]'))`,
      'global history'
    )
    const sideChatId = sideChatKey.split(':').slice(2).join(':')
    await waitFor(
      `Boolean(document.querySelector('[data-testid="session-history-item-chat:${botId}:${sideChatId}"]'))`,
      'side chat history row'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="session-history-item-chat:${botId}:${sideChatId}"]').click()`
    )
    await waitFor(
      `document.querySelectorAll('[data-testid^="bot-chat-tab-"]').length >= 1`,
      'reopened side chat'
    )
    await screenshot('05b-bot-side-chat-reopened')

    // The sidebar's global history spans sessions, tasks, rooms and chats.
    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-history"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="session-history"]'))`,
      'sidebar global history'
    )
    await waitFor(
      `document.querySelectorAll('[data-testid^="session-history-item-room:"]').length >= 1`,
      'room history row'
    )
    // Chat bodies are durable and searchable, not just their titles.
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="session-history-input"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set
      setter.call(input, "Tell me what you're working on")
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(
      `document.querySelectorAll('[data-testid^="session-history-item-chat:"]').length >= 1`,
      'chat transcript search'
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="session-history-input"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await cdp.evaluate(
      `document.querySelector('[data-testid="session-history-filter-chat"]').click()`
    )
    await waitFor(
      `document.querySelectorAll('[data-testid^="session-history-item-chat:"]').length >= 1`,
      'chat history filter'
    )
    await screenshot('05c-global-history')
    await cdp.evaluate(
      `document.querySelector('[data-testid="session-history-close"]').click()`
    )
  })

  await step('start a new Home Chat and keep the old one in history', async () => {
    const oldHomeKey = await cdp.evaluate(
      `document.querySelector('[data-testid="bot-home-tab"]').getAttribute('data-tab-key')`
    )
    assert(typeof oldHomeKey === 'string', 'The Home tab lost its key')
    await cdp.evaluate(
      `document.querySelector('[data-testid="bot-chat-new"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bot-new-home-chat-item"]'))`,
      'new home chat menu item'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="bot-new-home-chat-item"]').click()`
    )
    await waitFor(
      `document.querySelector('[data-testid="bot-home-tab"]')?.getAttribute('data-tab-key') !== ${JSON.stringify(oldHomeKey)}`,
      'replaced Home tab'
    )
    assert(
      (await cdp.evaluate(
        `document.querySelectorAll('[data-testid^="bot-chat-tab-"]').length`
      )) >= 1,
      'A new Home Chat closed the open side chat'
    )
    const oldHomeId = oldHomeKey.split(':').slice(2).join(':')
    await cdp.evaluate(
      `document.querySelector('[data-testid="bots-open-history"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="session-history-item-chat:${botId}:${oldHomeId}"]'))`,
      'replaced Home Chat in history'
    )
    await screenshot('05d-new-home-chat')
    await cdp.evaluate(
      `document.querySelector('[data-testid="session-history-close"]').click()`
    )
  })

  writeFileSync(
    join(ARTIFACT_DIR, 'bots-smoke.json'),
    JSON.stringify(
      { status: 'passed', runDir: RUN_DIR, steps, artifacts, userData: USER_DATA },
      null,
      2
    )
  )
  await quit()
  log(`status: passed`)
  log(`evidence: ${join(ARTIFACT_DIR, 'bots-smoke.json')}`)
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  log(`FAILED: ${message}`)
  try {
    if (cdp) {
      const body = await cdp.evaluate('document.body.innerText.slice(0, 4000)')
      log(`body: ${body}`)
    }
  } catch {}
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true })
    writeFileSync(
      join(ARTIFACT_DIR, 'bots-smoke.json'),
      JSON.stringify(
        { status: 'failed', error: message, runDir: RUN_DIR, steps, artifacts },
        null,
        2
      )
    )
  } catch {}
  await quit()
  process.exitCode = 1
})
