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
    assert(
      await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="app-tab-bots-group:${groupId}"]'))`
      ),
      'The group did not open as a center tab'
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

  await step('open a bot home, pause it, and read its memory tab', async () => {
    await cdp.evaluate(
      `document.querySelector('[data-testid="sidebar-bots-bot-${botId}"]').click()`
    )
    await waitFor(
      `Boolean(document.querySelector('[data-testid="bots-open-settings"]'))`,
      'bot settings entry'
    )
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
    await screenshot('04-bot-memory')
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
