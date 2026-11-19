import type {
  HarnessDetection,
  HarnessId
} from '../../../shared/domain/harness'
import {
  HARNESS_DEFINITIONS_LIST,
  harnessLabel,
  isAgentHarness
} from '../../../shared/domain/harness'
import { isManagedHookProvider } from '../../../shared/domain/managed-hook-providers'
import type { ManagedHooksStatePayload } from '../../../shared/schemas/managed-hooks'
import type { OpenCodeIntegrationStatePayload } from '../../../shared/schemas/opencode-integration'

export type AgentStatus =
  | 'checking'
  | 'failed'
  | 'partial'
  | 'unsupported'
  | 'installed'
  | 'plugin'
  | 'status-off'
  | 'not-installed'
  | 'launch-only'
  | 'missing'

export type AgentRow = {
  id: HarnessId
  label: string
  version: string | null
  status: AgentStatus
  detail: string | null
  configPath: string | null
  executablePath: string | null
  integrated: boolean
  defaultVisible: boolean
}

export type AgentRowsInput = {
  harnesses: HarnessDetection[]
  harnessLoading: boolean
  managedHooks: ManagedHooksStatePayload | null
  managedError: string | null
  opencode: OpenCodeIntegrationStatePayload | null
  opencodeError: string | null
}

export type AgentMasterState = {
  checked: boolean
  indeterminate: boolean
  disabled: boolean
}

const SEVERITY: Record<AgentStatus, number> = {
  failed: 0,
  partial: 1,
  unsupported: 2,
  installed: 3,
  plugin: 3,
  'status-off': 4,
  'not-installed': 5,
  'launch-only': 6,
  missing: 7,
  checking: 8
}

const CATALOG = HARNESS_DEFINITIONS_LIST.filter((entry) => isAgentHarness(entry.id))

function openCodeConfigDir(opencode: OpenCodeIntegrationStatePayload): string {
  return opencode.install.configDir
}

function openCodeDetail(opencode: OpenCodeIntegrationStatePayload): string | null {
  return opencode.install.state === 'failed' || opencode.install.state === 'unsupported'
    ? opencode.install.detail
    : null
}

function openCodeInstalled(opencode: OpenCodeIntegrationStatePayload | null): boolean {
  return opencode?.install.state === 'installed'
}

export function buildAgentRows(input: AgentRowsInput): AgentRow[] {
  const detections = new Map(input.harnesses.map((entry) => [entry.harness, entry]))
  const managed = new Map(
    (input.managedHooks?.providers ?? []).map((entry) => [entry.provider, entry])
  )
  const managedPending = input.managedHooks === null && input.managedError === null
  const opencodePending = input.opencode === null && input.opencodeError === null

  const rows = CATALOG.map((definition): AgentRow => {
    const id = definition.id
    const detection = detections.get(id)
    const managedProvider = isManagedHookProvider(id)
    const hook = managedProvider ? managed.get(id) : undefined
    const isOpenCode = id === 'opencode'
    const integrated = managedProvider || isOpenCode
    const openCodeInstall = isOpenCode ? input.opencode : null

    const detectionAvailable = detection?.state === 'available'
    const detectionUnsupported =
      detection?.state === 'unavailable' && detection.reason === 'unsupported'
    const openCodeUnsupported = openCodeInstall?.install.state === 'unsupported'
    const failed =
      detection?.state === 'detection_failed' ||
      hook?.state === 'failed' ||
      openCodeInstall?.install.state === 'failed'
    const partial = hook?.state === 'partial'
    const installed = hook?.state === 'installed'
    const plugin = openCodeInstalled(openCodeInstall)
    const disabledByMaster =
      hook?.state === 'disabled' || openCodeInstall?.enabled === false

    let status: AgentStatus
    if (
      (input.harnessLoading && detection === undefined) ||
      (managedProvider && managedPending) ||
      (isOpenCode && opencodePending)
    ) {
      status = 'checking'
    } else if (failed) {
      status = 'failed'
    } else if (partial) {
      status = 'partial'
    } else if (detectionUnsupported || openCodeUnsupported) {
      status = 'unsupported'
    } else if (installed) {
      status = 'installed'
    } else if (plugin) {
      status = 'plugin'
    } else if (integrated && disabledByMaster && detectionAvailable) {
      status = 'status-off'
    } else if (integrated && detectionAvailable) {
      status = 'not-installed'
    } else if (detectionAvailable) {
      status = 'launch-only'
    } else {
      status = 'missing'
    }

    const defaultVisible =
      (detection !== undefined && detection.state !== 'unavailable') ||
      hook?.state === 'installed' ||
      hook?.state === 'partial' ||
      hook?.state === 'failed' ||
      openCodeInstall?.install.state === 'installed' ||
      openCodeInstall?.install.state === 'unsupported' ||
      openCodeInstall?.install.state === 'failed'

    const detail =
      hook?.detail ??
      (openCodeInstall === null ? null : openCodeDetail(openCodeInstall)) ??
      (detection?.state === 'detection_failed' ? detection.message : null) ??
      (detection?.state === 'unavailable' ? detection.message : null)

    return {
      id,
      label: harnessLabel(id),
      version: detection?.state === 'available' ? detection.version : null,
      status,
      detail,
      configPath:
        hook?.configPath ?? (openCodeInstall === null ? null : openCodeConfigDir(openCodeInstall)),
      executablePath:
        detection?.state === 'available' ? detection.resolvedPath : null,
      integrated,
      defaultVisible
    }
  })

  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        SEVERITY[left.row.status] - SEVERITY[right.row.status] || left.index - right.index
    )
    .map(({ row }) => row)
}

export function visibleAgentRows(rows: AgentRow[], showAll: boolean): AgentRow[] {
  return showAll ? rows : rows.filter((row) => row.defaultVisible)
}

export function agentMasterState(
  managedHooks: ManagedHooksStatePayload | null,
  opencode: OpenCodeIntegrationStatePayload | null,
  managedError: string | null,
  opencodeError: string | null
): AgentMasterState {
  const disabled =
    managedHooks === null ||
    opencode === null ||
    (managedError !== null && managedHooks === null) ||
    (opencodeError !== null && opencode === null)
  return {
    checked: managedHooks?.enabled === true && opencode?.enabled === true,
    indeterminate:
      managedHooks !== null &&
      opencode !== null &&
      managedHooks.enabled !== opencode.enabled,
    disabled
  }
}
