import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { HarnessId } from '../../shared/domain/harness'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { WslCommandRunner } from '../wsl/exec'
import { MANAGED_HOOK_PROVIDER_IDS } from '../../shared/domain/managed-hook-providers'
import {
  MANAGED_HOOK_PROVIDER_SPECS,
  configPathFor,
  ensureManagedHookScript,
  providerForHarness,
  type ManagedHookInstallOptions,
  type ManagedHookProvider,
  type ManagedHookProviderStatus,
  type ManagedHookRuntime
} from './managed-hooks'
import type { GuestManagedHookOptions } from './managed-hooks-guest'
import { GUEST_HOOK_ADAPTERS, LOCAL_HOOK_ADAPTERS } from './managed-hooks-formats'

export type ManagedHooksState = {
  enabled: boolean
  providers: ManagedHookProviderStatus[]
}

export type ManagedHooksServiceOptions = {
  directory: string
  home: string
  execPath: string
  electronRunAsNode: boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  loadEnabled: () => boolean
  saveEnabled: (enabled: boolean) => boolean
  /** Whether the provider CLI is installed and launchable on this machine. */
  isAvailable: (provider: ManagedHookProvider) => boolean
  /** WSL integration; all three must be present for guest support. */
  runner?: WslCommandRunner
  readGuestHome?: (distro: string) => Promise<string | null>
  /** Windows executable and activity pipe, spelled for a guest command. */
  guestExecutablePath?: string
  activitySocket?: string
  /** Small JSON ledger so a restart can still clean guest installs. */
  guestStatePath?: string
}

type GuestTrackedState = {
  distros: Array<{ distro: string; guestHome: string }>
}

/**
 * Default-on managed status hooks for the supported provider CLIs.
 *
 * Installation is gated on CLI presence, like the reference implementation's startup reconciler: iCode
 * does not write a config for an agent the user does not have. Turning the
 * setting off removes only marker-owned entries; user hooks remain untouched.
 * The setting is persisted, so a restart cannot silently re-enable files the
 * user turned off.
 *
 * Local installs happen at startup. Guest installs happen on the first WSL
 * session for a provider because the distro and its home are only known then.
 */
export class ManagedHooksService {
  private readonly listeners = new Set<(state: ManagedHooksState) => void>()
  /** Distros seen in this run; the key is folded, the value keeps the spelling. */
  private readonly guestInstalls = new Map<
    string,
    { distro: string; guestHome: string; providers: Set<ManagedHookProvider> }
  >()

  constructor(private readonly options: ManagedHooksServiceOptions) {
    this.loadGuestState()
  }

  getState(): ManagedHooksState {
    const enabled = this.options.loadEnabled()
    return {
      enabled,
      providers: MANAGED_HOOK_PROVIDER_IDS.map((provider) => this.statusFor(provider, enabled))
    }
  }

  /**
   * Startup reconciliation. It is safe to call before the window exists and
   * never throws into app startup.
   */
  refresh(): ManagedHooksState {
    const state = this.getState()
    if (!state.enabled) return state
    for (const provider of MANAGED_HOOK_PROVIDER_IDS) {
      if (!this.options.isAvailable(provider)) continue
      try {
        this.installLocal(provider)
      } catch {
        // The status read below reports the failure; never block startup.
      }
    }
    return this.getState()
  }

  async setEnabled(enabled: boolean): Promise<ManagedHooksState> {
    if (!this.options.saveEnabled(enabled)) {
      // Do not change user-global configs when the preference could not be
      // persisted; a restart would otherwise contradict what was just done.
      return this.getState()
    }
    if (enabled) {
      const state = this.refresh()
      this.emit(state)
      return state
    }
    for (const provider of MANAGED_HOOK_PROVIDER_IDS) {
      try {
        this.removeLocal(provider)
      } catch {
        // A broken config must not leave the toggle unusable.
      }
    }
    await this.removeGuestHooks()
    const state = this.getState()
    this.emit(state)
    return state
  }

  /**
   * Installs the hook before a provider starts, so a CLI installed after app
   * startup is covered on its first session. Guest installs are per-distro and
   * happen here because startup has no repository target.
   */
  async prepareForSession(
    harness: HarnessId,
    target: ExecutionTarget,
    detection: HarnessDetectionResult | null
  ): Promise<void> {
    const provider = providerForHarness(harness)
    if (provider === null) return
    if (!this.options.loadEnabled()) return
    if (detection?.state !== 'available') return
    if (target.kind === 'local') {
      if (!this.options.isAvailable(provider)) return
      try {
        this.installLocal(provider)
      } catch {
        // Status and the session itself must survive a config write failure.
      }
      return
    }

    if (
      this.options.runner === undefined ||
      this.options.readGuestHome === undefined ||
      this.options.guestExecutablePath === undefined ||
      this.options.activitySocket === undefined
    ) {
      return
    }
    try {
      const key = target.distro.trim().toLowerCase()
      if (this.guestInstalls.get(key)?.providers.has(provider) === true) return
      const guestHome = await this.options.readGuestHome(target.distro)
      if (guestHome === null) return
      const runtime = ensureManagedHookScript(this.installOptions())
      const status = await this.installGuestFor(provider, {
        runner: this.options.runner,
        distro: target.distro,
        provider,
        guestHome,
        guestExecutablePath: this.options.guestExecutablePath,
        scriptPath: runtime.scriptPath,
        activitySocket: this.options.activitySocket,
        electronRunAsNode: this.options.electronRunAsNode
      })
      if (status.state === 'installed' || status.state === 'partial') {
        this.trackGuest(target.distro, guestHome, provider)
      }
    } catch {
      // Guest setup is advisory; the session must still start.
    }
  }

  subscribe(listener: (state: ManagedHooksState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private loadGuestState(): void {
    const path = this.options.guestStatePath
    if (path === undefined || !existsSync(path)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      const distros = (parsed as { distros?: unknown }).distros
      if (!Array.isArray(distros)) return
      for (const item of distros) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
        const record = item as Record<string, unknown>
        const distro = typeof record.distro === 'string' ? record.distro.trim() : ''
        const guestHome =
          typeof record.guestHome === 'string' && record.guestHome.startsWith('/')
            ? record.guestHome
            : ''
        if (distro.length === 0 || guestHome.length === 0) continue
        this.guestInstalls.set(distro.toLowerCase(), {
          distro,
          guestHome,
          // The ledger proves cleanup ownership, not which provider was
          // installed; the first session per provider verifies its config.
          providers: new Set()
        })
      }
    } catch {
      // A corrupt ledger is not a startup dependency.
    }
  }

  private persistGuestState(): void {
    const path = this.options.guestStatePath
    if (path === undefined) return
    const state: GuestTrackedState = {
      distros: [...this.guestInstalls.values()].map(({ distro, guestHome }) => ({
        distro,
        guestHome
      }))
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.tmp`
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(temporary, path)
    } catch {
      // Best effort; the in-memory map still covers this run.
    }
  }

  private trackGuest(
    distro: string,
    guestHome: string,
    provider: ManagedHookProvider
  ): void {
    const key = distro.trim().toLowerCase()
    const current = this.guestInstalls.get(key)
    if (current === undefined) {
      this.guestInstalls.set(key, {
        distro: distro.trim(),
        guestHome,
        providers: new Set([provider])
      })
    } else {
      current.guestHome = guestHome
      current.providers.add(provider)
    }
    this.persistGuestState()
  }

  private async removeGuestHooks(): Promise<void> {
    if (this.options.runner === undefined) {
      this.guestInstalls.clear()
      return
    }
    // Only distros that actually had a session in this run are touched. Reading
    // every registered distro's home would start stopped distros just to delete
    // a hook, which is worse than leaving a dormant entry behind.
    for (const entry of this.guestInstalls.values()) {
      for (const provider of MANAGED_HOOK_PROVIDER_IDS) {
        try {
          await this.removeGuestFor(
            provider,
            this.guestOptions(entry.distro, provider, entry.guestHome)
          )
        } catch {
          // Best effort: a stopped distro cannot be cleaned until next use.
        }
      }
    }
    this.guestInstalls.clear()
    this.persistGuestState()
  }

  private guestOptions(
    distro: string,
    provider: ManagedHookProvider,
    guestHome: string
  ): GuestManagedHookOptions {
    const runtime = ensureManagedHookScript(this.installOptions())
    return {
      runner: this.options.runner!,
      distro,
      provider,
      guestHome,
      guestExecutablePath: this.options.guestExecutablePath ?? '',
      scriptPath: runtime.scriptPath,
      activitySocket: this.options.activitySocket ?? '',
      electronRunAsNode: this.options.electronRunAsNode
    }
  }

  private runtimeFor(options: ManagedHookInstallOptions): () => ManagedHookRuntime {
    let runtime: ManagedHookRuntime | null = null
    return () => (runtime ??= ensureManagedHookScript(options))
  }

  private installLocal(provider: ManagedHookProvider): ManagedHookProviderStatus {
    const options = this.installOptions()
    return LOCAL_HOOK_ADAPTERS[MANAGED_HOOK_PROVIDER_SPECS[provider].format].install(
      provider,
      { options, runtime: this.runtimeFor(options) }
    )
  }

  private removeLocal(provider: ManagedHookProvider): ManagedHookProviderStatus {
    const options = this.installOptions()
    return LOCAL_HOOK_ADAPTERS[MANAGED_HOOK_PROVIDER_SPECS[provider].format].remove(
      provider,
      { options, runtime: this.runtimeFor(options) }
    )
  }

  private localStatus(provider: ManagedHookProvider): ManagedHookProviderStatus {
    const options = this.installOptions()
    return LOCAL_HOOK_ADAPTERS[MANAGED_HOOK_PROVIDER_SPECS[provider].format].status(
      provider,
      { options, runtime: this.runtimeFor(options) }
    )
  }

  private async installGuestFor(
    provider: ManagedHookProvider,
    options: GuestManagedHookOptions
  ): Promise<ManagedHookProviderStatus> {
    return GUEST_HOOK_ADAPTERS[MANAGED_HOOK_PROVIDER_SPECS[provider].format].install(options)
  }

  private async removeGuestFor(
    provider: ManagedHookProvider,
    options: GuestManagedHookOptions
  ): Promise<ManagedHookProviderStatus> {
    return GUEST_HOOK_ADAPTERS[MANAGED_HOOK_PROVIDER_SPECS[provider].format].remove(options)
  }

  private statusFor(
    provider: ManagedHookProvider,
    enabled: boolean
  ): ManagedHookProviderStatus {
    const label = MANAGED_HOOK_PROVIDER_SPECS[provider].label
    const configPath = configPathFor(provider, this.installOptions())
    if (!enabled) {
      return {
        provider,
        label,
        state: 'disabled',
        configPath,
        detail: null
      }
    }
    if (!this.options.isAvailable(provider)) {
      return {
        provider,
        label,
        state: 'cli-not-found',
        configPath,
        detail: null
      }
    }
    try {
      return this.localStatus(provider)
    } catch (error) {
      return {
        provider,
        label,
        state: 'failed',
        configPath,
        detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      }
    }
  }

  private installOptions(): ManagedHookInstallOptions {
    return {
      directory: this.options.directory,
      home: this.options.home,
      execPath: this.options.execPath,
      electronRunAsNode: this.options.electronRunAsNode,
      ...(this.options.platform ? { platform: this.options.platform } : {}),
      ...(this.options.env ? { env: this.options.env } : {})
    }
  }

  private emit(state: ManagedHooksState): void {
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch {
        // A renderer listener must not break the service.
      }
    }
  }
}
