/**
 * The iCode-owned OpenCode status plugins.
 *
 * These strings are installed as plain ESM files. They import only Node
 * built-ins, read their identity from the PTY environment on every report, and
 * stay inert when iCode did not start the process. The same source exports the
 * OpenCode 1 bare factory and the OpenCode 2 `{ id, server, setup }` object; the
 * launch environment selects the shape.
 */

export const OPENCODE_PLUGIN_MARKER = '/* icode-opencode-status */'

const COMMON = `${OPENCODE_PLUGIN_MARKER}
import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_PROTOCOL_VERSION = 2
const MAX_TEXT = 4000
const POST_DEBOUNCE_MS = 50
const POST_TIMEOUT_MS = 1500
const PLUGIN_ID = 'icode-opencode-status'
let requestCounter = 0

function trimText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : null
}

function childLabel(value, fallback) {
  const text = typeof value === 'string' ? value.slice(0, 160) : ''
  return text.length > 0 ? text : fallback
}

function readIdentity() {
  const env = process.env
  if (
    !env.ICODE_SESSION_ID ||
    !env.ICODE_SESSION_INCARNATION ||
    !env.ICODE_HOST_SOCKET ||
    !env.ICODE_HOST_DIR
  ) {
    return null
  }
  let token
  try {
    token = readFileSync(join(env.ICODE_HOST_DIR, 'token'), 'utf8').trim()
  } catch {
    return null
  }
  if (!token) return null
  return {
    sessionId: env.ICODE_SESSION_ID,
    incarnationId: env.ICODE_SESSION_INCARNATION,
    socket: env.ICODE_HOST_SOCKET,
    token,
    sharedServer: process.argv.includes('serve')
  }
}

function sendRequest(identity, method, params) {
  return new Promise((resolve) => {
    let settled = false
    let buffer = ''
    const socket = createConnection(identity.socket)
    const timer = setTimeout(() => finish(), POST_TIMEOUT_MS)
    timer.unref?.()
    function finish() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve()
    }
    function takeLine() {
      const newline = buffer.indexOf('\\n')
      if (newline < 0) return null
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }
    socket.once('error', finish)
    socket.once('connect', () => {
      socket.write(
        JSON.stringify({
          type: 'hello',
          protocolVersion: HOST_PROTOCOL_VERSION,
          token: identity.token,
          clientId: 'icode-opencode-' + String(process.pid)
        }) + '\\n'
      )
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const hello = takeLine()
      if (hello === null) return
      if (!hello || hello.type !== 'hello' || hello.ok !== true) return finish()
      requestCounter += 1
      socket.write(
        JSON.stringify({
          type: 'request',
          id: 'opencode-status-' + String(requestCounter),
          method,
          params
        }) + '\\n'
      )
      socket.removeAllListeners('data')
      socket.on('data', (next) => {
        buffer += next.toString('utf8')
        if (takeLine() !== null) finish()
      })
    })
  })
}

function createReporter() {
  const identity = readIdentity()
  if (!identity) return null
  const state = { state: 'idle', prompt: null, message: null }
  let timer = null
  let disposed = false
  let inFlight = false
  let flushAgain = false
  function payload() {
    const next = { state: state.state, sentAt: Date.now() }
    if (state.kind) next.kind = state.kind
    if (state.toolName) next.toolName = state.toolName
    if (state.prompt !== null) next.prompt = state.prompt
    if (state.message !== null) next.message = state.message
    if (identity.sharedServer) next.sharedServer = true
    return next
  }
  function flush() {
    if (disposed) return
    if (inFlight) {
      flushAgain = true
      return
    }
    inFlight = true
    const next = payload()
    void sendRequest(identity, 'agentStatus', {
      sessionId: identity.sessionId,
      incarnationId: identity.incarnationId,
      payload: next
    }).finally(() => {
      inFlight = false
      if (flushAgain) {
        flushAgain = false
        flush()
      }
    })
  }
  const api = {
    update(patch) {
      if (disposed) return
      Object.assign(state, patch)
      if (patch.kind === null) delete state.kind
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null
          flush()
        }, POST_DEBOUNCE_MS)
        timer.unref?.()
      }
    },
    flush,
    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
  }
  // An OpenCode process with no turn yet is still a live status source. Report
  // idle once on load so iCode can prove the plugin-to-Host path before the
  // first session event (and so a resumed TUI does not remain unknown).
  api.update({ state: 'idle' })
  return api
}

function createLifecycleReporter() {
  const reporter = createReporter()
  if (!reporter) return null
  const children = new Map()
  const roleByMessage = new Map()
  let root = null
  let rootEnded = false
  function isChild(sessionID) {
    return sessionID !== null && children.has(sessionID)
  }
  function childSnapshot() {
    return [...children.values()].slice(0, 32)
  }
  function publishChildren() {
    reporter.update({ subagents: childSnapshot() })
  }
  function setChild(sessionID, patch) {
    if (!sessionID) return
    const existing = children.get(sessionID) || {
      id: sessionID,
      label: sessionID.slice(0, 12),
      state: 'idle',
      toolName: null
    }
    Object.assign(existing, patch)
    if (patch.kind === null) delete existing.kind
    children.set(sessionID, existing)
    publishChildren()
  }
  function retireChild(sessionID) {
    if (!sessionID) return
    children.delete(sessionID)
    publishChildren()
    if (rootEnded && activeChildren().length === 0) {
      reporter.update({ state: 'done', kind: null, toolName: null })
    }
  }
  function setRoot(sessionID) {
    if (root === null && sessionID) root = sessionID
  }
  function activeChildren() {
    return [...children.values()].filter(
      (child) => child.state === 'working' || child.state === 'waiting'
    )
  }
  function onEvent(event) {
    if (!event || typeof event.type !== 'string') return
    const properties = event.properties || {}
    const info = properties.info
    if (event.type === 'session.created') {
      const sessionID = info?.id || properties.sessionID
      if (!sessionID) return
      if (info?.parentID || properties.parentID) {
        setChild(sessionID, {
          label: childLabel(info?.title || info?.slug, sessionID.slice(0, 12)),
          state: 'idle',
          toolName: null
        })
        return
      }
      setRoot(sessionID)
      rootEnded = false
      children.clear()
      reporter.update({
        state: 'idle',
        kind: null,
        toolName: null,
        prompt: null,
        message: null,
        subagents: []
      })
      return
    }
    if (event.type === 'session.deleted') {
      const sessionID = info?.id || properties.sessionID
      if (sessionID) retireChild(sessionID)
      return
    }
    const sessionID =
      properties.sessionID || info?.sessionID || properties.part?.sessionID || null
    if (sessionID && isChild(sessionID)) {
      if (event.type === 'session.status') {
        const type = properties.status?.type
        if (type === 'busy' || type === 'retry') setChild(sessionID, { state: 'working', kind: null })
        else if (type === 'idle') retireChild(sessionID)
      } else if (event.type === 'session.idle') {
        retireChild(sessionID)
      } else if (event.type === 'permission.asked') {
        setChild(sessionID, { state: 'waiting', kind: 'permission', toolName: properties.permission || null })
      } else if (event.type === 'permission.replied') {
        setChild(sessionID, { state: 'working', kind: null })
      } else if (event.type === 'question.asked') {
        setChild(sessionID, { state: 'waiting', kind: 'question', toolName: 'AskUserQuestion' })
      } else if (event.type === 'question.replied' || event.type === 'question.rejected') {
        setChild(sessionID, { state: 'working', kind: null })
      } else if (event.type === 'session.error') {
        retireChild(sessionID)
      }
      return
    }
    if (!sessionID) return
    if (root !== null && sessionID !== root) return
    setRoot(sessionID)

    if (event.type === 'session.status') {
      const type = properties.status?.type
      if (type === 'busy' || type === 'retry') {
        rootEnded = false
        reporter.update({ state: 'working', kind: null, toolName: null })
      } else if (type === 'idle') {
        rootEnded = true
        reporter.update({ state: activeChildren().length > 0 ? 'working' : 'idle' })
      }
      return
    }
    if (event.type === 'session.idle') {
      rootEnded = true
      reporter.update({
        state: activeChildren().length > 0 ? 'working' : 'done',
        kind: null,
        toolName: null
      })
      return
    }
    if (event.type === 'session.error') {
      reporter.update({ state: 'error', kind: null, toolName: null })
      return
    }
    if (event.type === 'permission.asked') {
      reporter.update({
        state: 'waiting',
        kind: 'permission',
        toolName: typeof properties.permission === 'string' ? properties.permission : null
      })
      return
    }
    if (event.type === 'permission.replied') {
      reporter.update({ state: 'working', kind: null, toolName: null })
      return
    }
    if (event.type === 'question.asked') {
      reporter.update({ state: 'waiting', kind: 'question', toolName: 'AskUserQuestion' })
      return
    }
    if (event.type === 'question.replied' || event.type === 'question.rejected') {
      reporter.update({ state: 'working', kind: null, toolName: null })
      return
    }
    if (event.type === 'message.updated') {
      if (info?.id && info?.role) roleByMessage.set(info.id, info.role)
      return
    }
    if (event.type === 'message.part.updated') {
      const part = properties.part
      if (!part || part.type !== 'text' || !part.text || part.synthetic === true) return
      const role = roleByMessage.get(part.messageID)
      if (role === 'user') reporter.update({ prompt: trimText(part.text) })
      else if (role === 'assistant') reporter.update({ message: trimText(part.text) })
      return
    }
    if (event.type === 'session.next.prompt.admitted') {
      const prompt = properties.prompt?.text
      if (typeof prompt === 'string' && prompt.length > 0) {
        reporter.update({ prompt: trimText(prompt), state: 'working', kind: null })
      }
      return
    }
    if (event.type === 'session.next.text.ended' || event.type === 'session.text.ended') {
      if (typeof properties.text === 'string' && properties.text.length > 0) {
        reporter.update({ message: trimText(properties.text) })
      }
      return
    }
    if (event.type === 'session.inbox.enqueued') {
      const item = properties.item
      if (item?.type === 'user' && typeof item.payload?.text === 'string') {
        reporter.update({ prompt: trimText(item.payload.text), state: 'working', kind: null })
      }
      return
    }
  }
  return { onEvent, dispose: () => reporter.dispose() }
}

function translateV2(type, data) {
  const properties = data || {}
  if (type === 'session.created') {
    return {
      type: 'session.created',
      properties: { info: { id: properties.sessionID, parentID: properties.parentID } }
    }
  }
  if (type === 'session.execution.started') {
    return { type: 'session.status', properties: { ...properties, status: { type: 'busy' } } }
  }
  if (type === 'session.execution.succeeded') {
    return { type: 'session.idle', properties }
  }
  if (type === 'session.execution.interrupted') {
    return { type: 'session.status', properties: { ...properties, status: { type: 'idle' } } }
  }
  if (type === 'session.execution.failed') {
    return { type: 'session.error', properties }
  }
  if (type === 'permission.v2.asked') {
    return {
      type: 'permission.asked',
      properties: { ...properties, permission: properties.action }
    }
  }
  if (type === 'permission.v2.replied') {
    return { type: 'permission.replied', properties }
  }
  if (type === 'question.v2.asked') {
    return { type: 'question.asked', properties }
  }
  if (type === 'question.v2.replied') {
    return { type: 'question.replied', properties }
  }
  if (type === 'question.v2.rejected') {
    return { type: 'question.rejected', properties }
  }
  if (type === 'form.created') {
    return { type: 'question.asked', properties: { ...properties, ...(properties.form || {}) } }
  }
  if (type === 'form.replied') {
    return { type: 'question.replied', properties }
  }
  if (type === 'form.cancelled') {
    return { type: 'question.rejected', properties }
  }
  if (
    type === 'session.next.step.started' ||
    type === 'session.next.tool.called' ||
    type === 'session.next.tool.progress' ||
    type === 'session.next.retried'
  ) {
    return { type: 'session.status', properties: { ...properties, status: { type: 'busy' } } }
  }
  if (type === 'session.next.text.ended' || type === 'session.text.ended') {
    return { type, properties }
  }
  if (type === 'session.next.prompt.admitted' || type === 'session.inbox.enqueued') {
    return { type, properties }
  }
  return { type, properties }
}

function isV2TuiContext(ctx) {
  return (
    typeof ctx?.ui?.router?.current === 'function' &&
    typeof ctx?.data?.listen === 'function'
  )
}

// OpenCode 2 TUI data is authoritative; derive from it instead of latching
// events, so reconnects and hot reload self-correct.
async function setupV2Tui(ctx) {
  const reporter = createReporter()
  if (!reporter) return async () => {}
  const session = ctx.data?.session
  const permissions = ctx.data?.permission
  const forms = ctx.data?.form
  let lastKey = ''
  let lastWorking = false
  const permissionSeenAt = new Map()

  function currentRoot() {
    const route = ctx.ui?.router?.current?.()
    if (!route || route.type !== 'session' || typeof route.sessionID !== 'string') {
      return undefined
    }
    return session?.root?.(route.sessionID) || route.sessionID
  }

  function refresh() {
    const root = currentRoot()
    if (!root) return
    const rows = []
    let childWaiting = false
    let childWorking = false
    const family = typeof session?.family === 'function' ? session.family(root) || [] : []
    for (const child of family) {
      if (!child || child === root) continue
      const childPermissions = permissions?.list?.(child) || []
      const childForms = forms?.list?.(child) || []
      const childStatus = session?.status?.(child)
      const childRunning =
        childStatus === 'running' || childStatus === 'busy' || childStatus?.type === 'busy'
      const childState = childPermissions.length || childForms.length
        ? 'waiting'
        : childRunning
          ? 'working'
          : 'idle'
      if (childState === 'waiting') childWaiting = true
      if (childState === 'working') childWorking = true
      rows.push({
        id: child,
        label: childLabel(session?.get?.(child)?.title, child.slice(0, 12)),
        state: childState,
        toolName: null,
        ...(childState === 'waiting'
          ? { kind: childPermissions.length > 0 ? 'permission' : 'question' }
          : {})
      })
    }
    const pendingPermissions = permissions?.list?.(root) || []
    const pendingForms = forms?.list?.(root) || []
    let kind
    if (pendingPermissions.length > 0) {
      const request = pendingPermissions[0]
      const id = request?.id || 'permission'
      if (!permissionSeenAt.has(id)) permissionSeenAt.set(id, Date.now())
      if (Date.now() - permissionSeenAt.get(id) >= 500) kind = 'permission'
    } else if (pendingForms.length > 0) {
      kind = 'question'
    }
    for (const id of permissionSeenAt.keys()) {
      if (!pendingPermissions.some((request) => request?.id === id)) permissionSeenAt.delete(id)
    }
    const status = session?.status?.(root)
    const running = status === 'running' || status === 'busy' || status?.type === 'busy'
    const next = kind
      ? 'waiting'
      : running || childWorking
        ? 'working'
        : lastWorking || childWaiting
          ? 'done'
          : 'idle'
    lastWorking = running || childWorking
    const key =
      next + ':' + (kind || '') + ':' + rows.map((row) => row.id + row.state).join(',')
    if (key === lastKey) return
    lastKey = key
    reporter.update({ state: next, kind: kind || null, subagents: rows.slice(0, 32) })
  }

  const unsubscribe = ctx.data.listen((input) => {
    try {
      const details = input?.details || input
      const properties = details?.data || details?.properties || {}
      if (details?.type === 'session.inbox.enqueued') {
        const item = properties.item
        if (item?.type === 'user' && typeof item.payload?.text === 'string') {
          reporter.update({ prompt: trimText(item.payload.text) })
        }
      } else if (
        (details?.type === 'session.text.ended' ||
          details?.type === 'session.next.text.ended') &&
        typeof properties.text === 'string'
      ) {
        reporter.update({ message: trimText(properties.text) })
      }
      refresh()
    } catch {
      // ignore
    }
  })
  const tick = setInterval(() => {
    try {
      refresh()
    } catch {
      // ignore
    }
  }, 100)
  tick.unref?.()
  refresh()
  return async () => {
    clearInterval(tick)
    try {
      unsubscribe?.()
    } catch {
      // ignore
    }
    reporter.dispose()
  }
}

async function setupV2(ctx) {
  if (!ctx) return async () => {}
  if (isV2TuiContext(ctx)) return setupV2Tui(ctx)
  if (
    typeof ctx.session?.hook !== 'function' ||
    typeof ctx.event?.subscribe !== 'function'
  ) {
    return async () => {}
  }
  const reporter = createLifecycleReporter()
  const controller = new AbortController()
  let promptHook
  try {
    promptHook = await ctx.session.hook('prompt', async (properties) => {
      reporter?.onEvent({ type: 'session.next.prompt.admitted', properties })
    })
  } catch {
    promptHook = undefined
  }
  const consuming = (async () => {
    try {
      for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) break
        reporter?.onEvent(translateV2(input?.type, input?.data))
      }
    } catch {
      // A status plugin must never fail the agent run.
    }
  })()
  return async () => {
    controller.abort()
    try {
      await promptHook?.dispose?.()
    } catch {
      // ignore
    }
    await consuming
    reporter?.dispose()
  }
}
`

const SERVER_TAIL = `
export async function ICodeOpenCodeStatus(_ctx) {
  const reporter = createLifecycleReporter()
  return {
    event: async ({ event }) => {
      try {
        reporter?.onEvent(event)
      } catch {
        // ignore
      }
    },
    dispose: async () => {
      try {
        reporter?.dispose()
      } catch {
        // ignore
      }
    }
  }
}

export default process.env.ICODE_OPENCODE_PLUGIN_API === 'v2'
  ? { id: PLUGIN_ID, server: ICodeOpenCodeStatus, setup: setupV2 }
  : ICodeOpenCodeStatus
`

const TUI_TAIL = `
async function setupTui(api) {
  if (!/^1\\./.test(String(api?.app?.version || ''))) return
  if (!process.argv.includes('attach')) return
  if (typeof api?.event?.on !== 'function') return
  const reporter = createReporter()
  if (!reporter) return
  const session = api.state?.session
  const roleByMessage = new Map()
  const childRoot = new Map()
  const childLabels = new Map()
  let lastKey = ''
  let rootEnded = false
  function rootOf(sessionID) {
    let current = sessionID
    const visited = new Set()
    for (let depth = 0; depth < 32; depth += 1) {
      if (!current || visited.has(current)) return undefined
      visited.add(current)
      const parent = session?.get?.(current)?.parentID
      if (!parent) return current
      current = parent
    }
    return undefined
  }
  function refresh(sessionID) {
    const root = rootOf(sessionID) || sessionID
    if (!root) return
    const rows = []
    let childWaiting = false
    let childWorking = false
    for (const [child, owner] of childRoot) {
      const actualOwner = rootOf(child) || owner
      if (actualOwner !== owner) childRoot.set(child, actualOwner)
      if (actualOwner !== root) continue
      if (!session?.get?.(child)) {
        childRoot.delete(child)
        continue
      }
      const childPermissions = session?.permission?.(child) || []
      const childQuestions = session?.question?.(child) || []
      const childStatus = session?.status?.(child)?.type
      const childState = childPermissions.length
        ? 'waiting'
        : childQuestions.length
          ? 'waiting'
          : childStatus === 'busy' || childStatus === 'retry'
            ? 'working'
            : 'idle'
      if (childState === 'waiting') childWaiting = true
      if (childState === 'working') childWorking = true
      rows.push({
        id: child,
        label: childLabels.get(child) || child.slice(0, 12),
        state: childState,
        toolName: null,
        ...(childState === 'waiting'
          ? { kind: childPermissions.length ? 'permission' : 'question' }
          : {})
      })
    }
    const permissions = session?.permission?.(root) || []
    const questions = session?.question?.(root) || []
    const status = session?.status?.(root)?.type
    let state
    let kind
    if (permissions.length > 0) {
      state = 'waiting'
      kind = 'permission'
    } else if (questions.length > 0) {
      state = 'waiting'
      kind = 'question'
    } else if (status === 'busy' || status === 'retry' || childWorking) {
      state = 'working'
    } else if (rootEnded && (childWaiting || childWorking)) {
      state = 'working'
    } else if (rootEnded) {
      state = 'done'
    } else {
      state = 'idle'
    }
    const key = state + ':' + (kind || '') + ':' + rows.map((row) => row.id + row.state).join(',')
    if (key === lastKey) return
    lastKey = key
    reporter.update({ state, kind: kind || null, subagents: rows.slice(0, 32) })
  }
  const unsubscribers = types.map((type) =>
    api.event.on(type, (input) => {
      try {
        const event = input?.details || input
        const properties = event?.properties || {}
        const sessionID =
          properties.sessionID ||
          properties.info?.id ||
          properties.info?.sessionID ||
          properties.part?.sessionID
        if (!sessionID) return
        if (type === 'session.created') {
          if (properties.info?.parentID) {
            const owner = rootOf(properties.info.parentID) || properties.info.parentID
            childRoot.set(sessionID, owner)
            childLabels.set(
              sessionID,
              childLabel(properties.info.title || properties.info.slug, sessionID.slice(0, 12))
            )
          } else {
            childRoot.clear()
            childLabels.clear()
            rootEnded = false
            lastKey = ''
            reporter.update({ state: 'idle', kind: null, prompt: null, message: null, subagents: [] })
          }
          refresh(sessionID)
          return
        }
        if (type === 'session.deleted') {
          childRoot.delete(sessionID)
          childLabels.delete(sessionID)
          refresh(sessionID)
          return
        }
        if (childRoot.has(sessionID)) {
          if (type === 'session.error') {
            childRoot.delete(sessionID)
            childLabels.delete(sessionID)
          }
          refresh(sessionID)
          return
        }
        if (type === 'message.updated') {
          if (properties.info?.id && properties.info?.role) {
            roleByMessage.set(properties.info.id, properties.info.role)
          }
          return
        }
        if (type === 'message.part.updated') {
          const part = properties.part
          if (!part || part.type !== 'text' || !part.text || part.synthetic === true) return
          const role = roleByMessage.get(part.messageID)
          if (role === 'user') reporter.update({ prompt: trimText(part.text) })
          else if (role === 'assistant') reporter.update({ message: trimText(part.text) })
          return
        }
        if (type === 'session.idle') {
          rootEnded = true
          refresh(sessionID)
          return
        }
        if (type === 'session.error') {
          reporter.update({ state: 'error', kind: null })
          return
        }
        refresh(sessionID)
      } catch {
        // ignore
      }
    })
  )
  api.lifecycle?.onDispose?.(() => {
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe?.()
      } catch {
        // ignore
      }
    }
    reporter.dispose()
  })
}

export default { id: PLUGIN_ID + '-tui', setup: setupV2, tui: setupTui }
`

export function openCodeServerPluginSource(): string {
  return COMMON + SERVER_TAIL
}

export function openCodeTuiPluginSource(): string {
  return COMMON + TUI_TAIL
}
