/**
 * Hermes loads a standalone Python plugin and passes only allowlisted client
 * environment names into a shared gateway.
 *
 * iCode owns `plugins/icode-status` and edits only `plugins.enabled`,
 * `plugins.disabled` and `terminal.client_env_passthrough` in config.yaml.
 * Local plugins post directly to the activity socket; a WSL plugin spawns the
 * Windows hook through interop because a guest process cannot open a Windows
 * named pipe.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import {
  MANAGED_HOOK_PROVIDER_SPECS,
  isRecord,
  type ManagedHookInstallOptions,
  type ManagedHookProviderStatus
} from './managed-hooks'
import {
  readGuestHookText,
  removeGuestHookDir,
  writeGuestHookText,
  type GuestManagedHookOptions
} from './managed-hooks-guest'
import { readTextOrNull, writeTextAtomic } from './managed-hooks-text'

export const HERMES_PLUGIN_NAME = 'icode-status'
export const HERMES_PLUGIN_MARKER = 'Managed by iCode. Do not edit; changes may be overwritten.'
export const HERMES_PLUGIN_EVENTS = [
  'on_session_start',
  'on_session_reset',
  'pre_llm_call',
  'pre_tool_call',
  'post_tool_call',
  'pre_approval_request',
  'post_approval_response',
  'post_llm_call',
  'on_session_end',
  'on_session_finalize'
] as const
export const HERMES_CLIENT_ENV_VARS = [
  'ICODE_ACTIVITY_SOCKET',
  'ICODE_SESSION_ID',
  'ICODE_SESSION_INCARNATION'
] as const

function manifest(): string {
  return [
    `# ${HERMES_PLUGIN_MARKER}`,
    `name: ${HERMES_PLUGIN_NAME}`,
    'version: 1.0.0',
    'description: "Reports Hermes Agent lifecycle events to iCode."',
    'author: "iCode"',
    'kind: standalone',
    'provides_hooks:',
    ...HERMES_PLUGIN_EVENTS.map((event) => `  - ${event}`),
    ''
  ].join('\n')
}

type PluginSourceOptions = {
  guestExecutablePath?: string
  scriptPath?: string
  activitySocket?: string
  electronRunAsNode?: boolean
}

function eventTable(): string {
  return JSON.stringify(
    {
      on_session_start: 'SessionStart',
      on_session_reset: 'SessionStart',
      pre_llm_call: 'UserPromptSubmit',
      pre_tool_call: 'PreToolUse',
      post_tool_call: 'PostToolUse',
      pre_approval_request: 'PermissionRequest',
      post_approval_response: 'PostToolUse',
      post_llm_call: 'Stop',
      on_session_end: 'Stop',
      on_session_finalize: 'Stop'
    },
    null,
    4
  )
}

function localPluginSource(): string {
  return `# ${HERMES_PLUGIN_MARKER}
from __future__ import annotations

import json
import os
import socket
import time
from typing import Any, Callable, Optional

try:
    from agent.session_client_env import bound_client_env
except ImportError:
    # Hermes before the shared gateway runs each pane's session in that pane's process.
    bound_client_env = None

EVENTS = ${eventTable()}
MAX_TEXT = 8192
TRUNCATED = "...[truncated]"


def _pane_env() -> Optional[dict[str, str]]:
    if bound_client_env is None:
        return dict(os.environ)
    client_env = bound_client_env()
    if client_env is None:
        return None
    return dict(client_env)


def _text(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    return value[:MAX_TEXT] + TRUNCATED if len(value) > MAX_TEXT else value


def _post(canonical: str, kwargs: dict[str, Any]) -> None:
    if str(kwargs.get("platform", "")) == "subagent":
        return
    env = _pane_env()
    if env is None:
        return
    path = env.get("ICODE_ACTIVITY_SOCKET", "")
    session_id = env.get("ICODE_SESSION_ID", "")
    incarnation_id = env.get("ICODE_SESSION_INCARNATION", "")
    if not path or not session_id or not incarnation_id:
        return
    tool_name = _text(kwargs.get("tool_name"))
    if canonical == "PermissionRequest":
        tool_name = "approval"
    prompt_id = _text(kwargs.get("task_id")) or _text(kwargs.get("tool_call_id"))
    payload = {
        "event": canonical,
        "sessionId": session_id,
        "incarnationId": incarnation_id,
        "claudeSessionId": _text(kwargs.get("session_id")),
        "promptId": prompt_id,
        "toolName": tool_name,
        "sentAt": int(time.time() * 1000),
    }
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    try:
        if os.name == "nt":
            with open(path, "wb", buffering=0) as pipe:
                pipe.write(body)
        else:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(0.2)
                client.connect(path)
                client.sendall(body)
    except Exception:
        # Status must never affect the Hermes turn.
        pass


def _make_hook(canonical: str) -> Callable[..., None]:
    def _hook(**kwargs: Any) -> None:
        _post(canonical, kwargs)

    return _hook


def register(ctx: Any) -> None:
    for event, canonical in EVENTS.items():
        ctx.register_hook(event, _make_hook(canonical))
`
}

function guestPluginSource(options: PluginSourceOptions): string {
  const executable = JSON.stringify(options.guestExecutablePath ?? '')
  const script = JSON.stringify(options.scriptPath ?? '')
  const pipe = JSON.stringify(options.activitySocket ?? '')
  const electron = options.electronRunAsNode === true
  return `# ${HERMES_PLUGIN_MARKER}
from __future__ import annotations

import json
import os
import subprocess
import time
from typing import Any, Callable

WINDOWS_EXEC = ${executable}
SCRIPT = ${script}
PIPE = ${pipe}
ELECTRON_RUN_AS_NODE = ${electron ? 'True' : 'False'}
EVENTS = ${eventTable()}
MAX_TEXT = 8192
TRUNCATED = "...[truncated]"


def _text(value: Any) -> Any:
    if not isinstance(value, str) or not value:
        return None
    return value[:MAX_TEXT] + TRUNCATED if len(value) > MAX_TEXT else value


def _post(canonical: str, kwargs: dict[str, Any]) -> None:
    if str(kwargs.get("platform", "")) == "subagent":
        return
    session_id = os.environ.get("ICODE_SESSION_ID", "")
    incarnation_id = os.environ.get("ICODE_SESSION_INCARNATION", "")
    if not session_id or not incarnation_id or not WINDOWS_EXEC or not SCRIPT:
        return
    tool_name = _text(kwargs.get("tool_name"))
    if canonical == "PermissionRequest":
        tool_name = "approval"
    payload = {
        "event": canonical,
        "sessionId": session_id,
        "incarnationId": incarnation_id,
        "claudeSessionId": _text(kwargs.get("session_id")),
        "promptId": _text(kwargs.get("task_id")) or _text(kwargs.get("tool_call_id")),
        "toolName": tool_name,
        "sentAt": int(time.time() * 1000),
    }
    env = dict(os.environ)
    env["ICODE_ACTIVITY_SOCKET"] = PIPE
    shared = "ICODE_ACTIVITY_SOCKET:ICODE_SESSION_ID:ICODE_SESSION_INCARNATION"
    if ELECTRON_RUN_AS_NODE:
        shared += ":ELECTRON_RUN_AS_NODE"
        env["ELECTRON_RUN_AS_NODE"] = "1"
    env["WSLENV"] = shared
    try:
        subprocess.run(
            [WINDOWS_EXEC, SCRIPT, "hermes", canonical, canonical, "none"],
            input=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=1.5,
        )
    except Exception:
        # Status must never affect the Hermes turn.
        pass


def _make_hook(canonical: str) -> Callable[..., None]:
    def _hook(**kwargs: Any) -> None:
        _post(canonical, kwargs)

    return _hook


def register(ctx: Any) -> None:
    for event, canonical in EVENTS.items():
        ctx.register_hook(event, _make_hook(canonical))
`
}

function configPath(options: ManagedHookInstallOptions): string {
  return MANAGED_HOOK_PROVIDER_SPECS.hermes.configPath(
    options.home,
    options.env ?? process.env
  )
}

function pluginDir(configFile: string): string {
  return join(dirname(configFile), 'plugins', HERMES_PLUGIN_NAME)
}

function childMap(root: unknown, key: string, create: () => unknown): unknown {
  if (!isMap(root)) return null
  const existing = root.get(key, true)
  if (existing !== undefined) return existing
  const created = create()
  root.set(key, created)
  return created
}

function existingChild(root: unknown, key: string): unknown {
  return isMap(root) ? root.get(key, true) : undefined
}

function stringItems(seq: unknown): string[] | null {
  if (!isSeq(seq)) return null
  const values: string[] = []
  for (const item of seq.items) {
    // `seq.add(string)` stores the raw value instead of a Scalar node.
    if (typeof item === 'string') {
      values.push(item)
      continue
    }
    if (!isScalar(item) || typeof item.value !== 'string') return null
    values.push(item.value)
  }
  return values
}

function addItem(seq: unknown, value: string): boolean {
  if (!isSeq(seq)) return false
  const values = stringItems(seq)
  if (values === null || values.includes(value)) return false
  seq.add(value)
  return true
}

function removeItem(seq: unknown, value: string): boolean {
  if (!isSeq(seq)) return false
  const before = seq.items.length
  seq.items = seq.items.filter(
    (item) => item !== value && !(isScalar(item) && item.value === value)
  )
  return seq.items.length !== before
}

function applyConfig(
  raw: string,
  enable: boolean
): { text: string; detail: string | null; applied: boolean } {
  if (!enable && raw.trim().length === 0) {
    return { text: raw, detail: null, applied: false }
  }
  const document = parseDocument(raw)
  if (document.errors.length > 0) {
    return {
      text: raw,
      detail: document.errors.map((error) => error.message).join('; '),
      applied: false
    }
  }
  if (document.contents === null) {
    document.contents = document.createNode({}) as never
  }
  const root = document.contents
  if (!isMap(root)) {
    return {
      text: raw,
      detail: 'Hermes config.yaml root must be a mapping.',
      applied: false
    }
  }
  let detail: string | null = null
  const plugins = enable
    ? childMap(root, 'plugins', () => document.createNode({}))
    : existingChild(root, 'plugins')
  if (plugins !== undefined) {
    if (!isMap(plugins)) {
      if (enable) {
        return { text: raw, detail: 'Hermes plugins must be a mapping.', applied: false }
      }
      detail = 'Hermes plugins is not a mapping; its entries were left untouched.'
    } else {
      const enabled = enable
        ? childMap(plugins, 'enabled', () => document.createNode([]))
        : existingChild(plugins, 'enabled')
      if (enabled !== undefined) {
        if (!isSeq(enabled)) {
          if (enable) {
            return { text: raw, detail: 'Hermes plugins.enabled must be a list.', applied: false }
          }
          detail = 'Hermes plugins.enabled is not a list.'
        } else if (enable) {
          addItem(enabled, HERMES_PLUGIN_NAME)
          removeItem(existingChild(plugins, 'disabled'), HERMES_PLUGIN_NAME)
        } else {
          removeItem(enabled, HERMES_PLUGIN_NAME)
        }
      } else if (enable) {
        return { text: raw, detail: 'Hermes plugins.enabled must be a list.', applied: false }
      }
    }
  }

  const terminal = enable
    ? childMap(root, 'terminal', () => document.createNode({}))
    : existingChild(root, 'terminal')
  if (terminal !== undefined) {
    if (!isMap(terminal)) {
      detail = 'Hermes terminal must be a mapping; client env passthrough was not updated.'
    } else {
      const passthrough = enable
        ? childMap(terminal, 'client_env_passthrough', () => document.createNode([]))
        : existingChild(terminal, 'client_env_passthrough')
      if (passthrough !== undefined) {
        if (!isSeq(passthrough)) {
          detail = 'Hermes terminal.client_env_passthrough must be a list.'
        } else if (enable) {
          for (const name of HERMES_CLIENT_ENV_VARS) addItem(passthrough, name)
        } else {
          for (const name of HERMES_CLIENT_ENV_VARS) removeItem(passthrough, name)
        }
      }
    }
  }
  return { text: document.toString({ lineWidth: 0 }), detail, applied: true }
}

type ParsedConfig = { value: Record<string, unknown> } | { error: string } | null

function parseConfig(raw: string | null): ParsedConfig {
  if (raw === null || raw.trim().length === 0) return { value: {} }
  const document = parseDocument(raw)
  if (document.errors.length > 0) return { error: document.errors[0]?.message ?? 'Invalid YAML.' }
  const value: unknown = document.toJS()
  return isRecord(value) ? { value } : { error: 'Hermes config.yaml root must be a mapping.' }
}

function listAt(value: unknown, key: string): string[] | null {
  if (!isRecord(value)) return []
  const list = value[key]
  if (list === undefined) return []
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) return null
  return list as string[]
}

function pluginFileState(dir: string): { present: boolean; managed: boolean; detail: string | null } {
  const manifestPath = join(dir, 'plugin.yaml')
  const initPath = join(dir, '__init__.py')
  if (!existsSync(manifestPath) || !existsSync(initPath)) {
    return { present: false, managed: false, detail: 'Hermes plugin files are missing.' }
  }
  try {
    const manifest = readFileSync(manifestPath, 'utf8')
    const init = readFileSync(initPath, 'utf8')
    const managed = manifest.includes(HERMES_PLUGIN_MARKER) && init.includes(HERMES_PLUGIN_MARKER)
    return {
      present: true,
      managed,
      detail: managed ? null : 'The Hermes plugin exists but is not iCode-managed.'
    }
  } catch (error) {
    return {
      present: true,
      managed: false,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

function statusFrom(
  configFile: string,
  raw: string | null,
  files: { present: boolean; managed: boolean; detail: string | null }
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS.hermes
  const base = { provider: 'hermes' as const, label: spec.label, configPath: configFile }
  const parsed = parseConfig(raw)
  if (parsed === null) return { ...base, state: 'not-installed', detail: null }
  if ('error' in parsed) return { ...base, state: 'failed', detail: parsed.error }
  const plugins = parsed.value.plugins
  const enabled = isRecord(plugins) ? listAt(plugins, 'enabled') : []
  const disabled = isRecord(plugins) ? listAt(plugins, 'disabled') : []
  const pluginEnabled = enabled?.includes(HERMES_PLUGIN_NAME) === true
  const pluginDisabled = disabled?.includes(HERMES_PLUGIN_NAME) === true
  const terminal = parsed.value.terminal
  const passthrough = isRecord(terminal) ? listAt(terminal, 'client_env_passthrough') : []
  const missingEnv =
    passthrough === null
      ? [...HERMES_CLIENT_ENV_VARS]
      : HERMES_CLIENT_ENV_VARS.filter((name) => !passthrough.includes(name))
  // Match Hermes' own state: no plugin files and no enablement means iCode has
  // not installed anything, even if the user had disabled the name earlier.
  if (!files.present && !pluginEnabled) {
    return { ...base, state: 'not-installed', detail: null }
  }
  const problems: string[] = []
  if (!files.managed) problems.push(files.detail ?? 'Hermes plugin files are not managed.')
  if (!pluginEnabled) problems.push('The iCode plugin is not enabled in Hermes config.yaml.')
  if (pluginDisabled) problems.push('The iCode plugin is disabled in Hermes config.yaml.')
  if (missingEnv.length > 0) {
    problems.push(`Missing client env passthrough: ${missingEnv.join(', ')}`)
  }
  if (problems.length === 0) return { ...base, state: 'installed', detail: null }
  return { ...base, state: 'partial', detail: problems.join('; ') }
}

export function localHermesStatus(
  options: ManagedHookInstallOptions
): ManagedHookProviderStatus {
  const configFile = configPath(options)
  let raw: string | null
  try {
    raw = readTextOrNull(configFile)
  } catch (error) {
    return {
      provider: 'hermes',
      label: MANAGED_HOOK_PROVIDER_SPECS.hermes.label,
      state: 'failed',
      configPath: configFile,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  return statusFrom(configFile, raw, pluginFileState(pluginDir(configFile)))
}

function writePluginFiles(dir: string, source: string): void {
  writeTextAtomic(join(dir, 'plugin.yaml'), manifest())
  writeTextAtomic(join(dir, '__init__.py'), source)
}

export function installLocalHermesHooks(
  options: ManagedHookInstallOptions
): ManagedHookProviderStatus {
  const configFile = configPath(options)
  let raw: string | null
  try {
    raw = readTextOrNull(configFile)
  } catch (error) {
    return {
      provider: 'hermes',
      label: MANAGED_HOOK_PROVIDER_SPECS.hermes.label,
      state: 'failed',
      configPath: configFile,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  const applied = applyConfig(raw ?? '', true)
  if (!applied.applied) {
    return {
      provider: 'hermes',
      label: MANAGED_HOOK_PROVIDER_SPECS.hermes.label,
      state: 'failed',
      configPath: configFile,
      detail: applied.detail ?? 'Could not update Hermes config.yaml.'
    }
  }
  writePluginFiles(pluginDir(configFile), localPluginSource())
  if (applied.text !== raw) writeTextAtomic(configFile, applied.text)
  return localHermesStatus(options)
}

export function removeLocalHermesHooks(
  options: ManagedHookInstallOptions
): ManagedHookProviderStatus {
  const configFile = configPath(options)
  let raw: string | null
  try {
    raw = readTextOrNull(configFile)
  } catch (error) {
    return {
      provider: 'hermes',
      label: MANAGED_HOOK_PROVIDER_SPECS.hermes.label,
      state: 'failed',
      configPath: configFile,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  if (raw !== null) {
    const applied = applyConfig(raw, false)
    if (applied.text !== raw) writeTextAtomic(configFile, applied.text)
  }
  const dir = pluginDir(configFile)
  if (pluginFileState(dir).managed) rmSync(dir, { recursive: true, force: true })
  return localHermesStatus(options)
}

function guestConfigPath(options: GuestManagedHookOptions): string {
  return `${options.guestHome.replace(/\/+$/u, '')}/.hermes/config.yaml`
}

function guestPluginDir(options: GuestManagedHookOptions): string {
  return `${options.guestHome.replace(/\/+$/u, '')}/.hermes/plugins/${HERMES_PLUGIN_NAME}`
}

export async function guestHermesStatus(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const configFile = guestConfigPath(options)
  const dir = guestPluginDir(options)
  const raw = await readGuestHookText(options.runner, options.distro, configFile, options.signal)
  const manifestPath = `${dir}/plugin.yaml`
  const initPath = `${dir}/__init__.py`
  const [pluginManifest, init] = await Promise.all([
    readGuestHookText(options.runner, options.distro, manifestPath, options.signal),
    readGuestHookText(options.runner, options.distro, initPath, options.signal)
  ])
  const present = pluginManifest !== null && init !== null
  const managed =
    pluginManifest !== null &&
    init !== null &&
    pluginManifest.includes(HERMES_PLUGIN_MARKER) &&
    init.includes(HERMES_PLUGIN_MARKER)
  return statusFrom(configFile, raw, {
    present,
    managed,
    detail: present ? (managed ? null : 'The Hermes plugin is not iCode-managed.') : 'Hermes plugin files are missing.'
  })
}

export async function installGuestHermesHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const configFile = guestConfigPath(options)
  const dir = guestPluginDir(options)
  const raw = await readGuestHookText(options.runner, options.distro, configFile, options.signal)
  const applied = applyConfig(raw ?? '', true)
  if (!applied.applied) {
    return {
      provider: 'hermes',
      label: MANAGED_HOOK_PROVIDER_SPECS.hermes.label,
      state: 'failed',
      configPath: configFile,
      detail: applied.detail ?? 'Could not update Hermes config.yaml.'
    }
  }
  // Publish plugin files before enabling them in config.
  await writeGuestHookText(
    options.runner,
    options.distro,
    `${dir}/plugin.yaml`,
    manifest(),
    options.signal
  )
  await writeGuestHookText(
    options.runner,
    options.distro,
    `${dir}/__init__.py`,
    guestPluginSource(options),
    options.signal
  )
  if (applied.text !== raw) {
    await writeGuestHookText(options.runner, options.distro, configFile, applied.text, options.signal)
  }
  return guestHermesStatus(options)
}

export async function removeGuestHermesHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const configFile = guestConfigPath(options)
  const raw = await readGuestHookText(options.runner, options.distro, configFile, options.signal)
  if (raw !== null) {
    const applied = applyConfig(raw, false)
    if (applied.text !== raw) {
      await writeGuestHookText(options.runner, options.distro, configFile, applied.text, options.signal)
    }
  }
  const dir = guestPluginDir(options)
  const manifestPath = `${dir}/plugin.yaml`
  const initPath = `${dir}/__init__.py`
  const [pluginManifest, init] = await Promise.all([
    readGuestHookText(options.runner, options.distro, manifestPath, options.signal),
    readGuestHookText(options.runner, options.distro, initPath, options.signal)
  ])
  if (
    pluginManifest?.includes(HERMES_PLUGIN_MARKER) === true &&
    init?.includes(HERMES_PLUGIN_MARKER) === true
  ) {
    await removeGuestHookDir(options.runner, options.distro, dir, options.signal)
  }
  return guestHermesStatus(options)
}
