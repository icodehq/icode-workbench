import { loadAppPreferences, updateAppPreferences } from '../../app/preferences'
import {
  openCodePluginApi,
  type HarnessId,
  type OpenCodePluginApi
} from '../../../shared/domain/harness'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import {
  installLocalOpenCodeIntegration,
  localInstallStatus,
  removeLocalOpenCodeIntegration,
  type OpenCodeInstallState
} from './installer'
import { resolveOpenCodeConfigDir } from './config-dir'
import {
  mirrorOpenCodeConfig,
  overlayDirFor,
  removeOpenCodeOverlay
} from './overlay'
import type { WslCommandRunner } from '../../wsl/exec'
import {
  installGuestOpenCodeIntegration,
  removeGuestOpenCodeIntegration,
  type GuestInstallState
} from './guest-installer'

export type OpenCodeIntegrationState = {
  enabled: boolean
  api: OpenCodePluginApi
  install: OpenCodeInstallState
}

export type OpenCodeIntegrationDeps = {
  /** Profile directory that holds preferences.json. */
  directory: string
  configDir?: () => string
  /** Test seams; production uses the installer module. */
  install?: typeof installLocalOpenCodeIntegration
  remove?: typeof removeLocalOpenCodeIntegration
  status?: typeof localInstallStatus
  loadEnabled?: () => boolean
  saveEnabled?: (enabled: boolean) => boolean
  /** WSL guest installer; absent means this build has no guest support. */
  runner?: WslCommandRunner
  installGuest?: typeof installGuestOpenCodeIntegration
  removeGuest?: typeof removeGuestOpenCodeIntegration
  /** Profile root for custom-config overlays. */
  userDataDir?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Owns the OpenCode setting and the local marker-owned install.
 *
 * The service is deliberately best-effort: a read-only profile or an OpenCode
 * upgrade that changes its config directory must not prevent sessions from
 * starting. A failed install is reported in state and the agent run continues.
 */
export class OpenCodeIntegrationService {
  private enabled: boolean
  private api: OpenCodePluginApi = 'unknown'
  private install: OpenCodeInstallState
  private localLaunchEnv: Record<string, string> = {}
  private localOverlay: { source: string; overlay: string } | null = null
  private readonly guestInstalls = new Map<string, GuestInstallState>()
  private readonly listeners = new Set<(state: OpenCodeIntegrationState) => void>()
  private readonly deps: Required<
    Pick<OpenCodeIntegrationDeps, 'directory' | 'install' | 'remove' | 'status'>
  > &
    OpenCodeIntegrationDeps

  constructor(deps: OpenCodeIntegrationDeps) {
    this.deps = {
      ...deps,
      directory: deps.directory,
      install: deps.install ?? installLocalOpenCodeIntegration,
      remove: deps.remove ?? removeLocalOpenCodeIntegration,
      status: deps.status ?? localInstallStatus
    }
    this.enabled = deps.loadEnabled
      ? deps.loadEnabled()
      : loadAppPreferences(deps.directory).opencodeIntegrationEnabled
    this.install = {
      state: 'not-installed',
      configDir: this.configDir()
    }
  }

  getState(): OpenCodeIntegrationState {
    return { enabled: this.enabled, api: this.api, install: this.install }
  }

  /** Install state for one distro, for tests and the Settings status rows. */
  getGuestState(distro: string): GuestInstallState | null {
    return this.guestInstalls.get(distro.trim().toLowerCase()) ?? null
  }

  subscribe(listener: (state: OpenCodeIntegrationState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Updates the detected CLI version; the layout can change between launches. */
  observeVersion(version: string | null): OpenCodePluginApi {
    this.api = openCodePluginApi(version)
    return this.api
  }

  async refresh(version: string | null): Promise<OpenCodeIntegrationState> {
    this.observeVersion(version)
    await this.syncLocal()
    this.emit()
    return this.getState()
  }

  async setEnabled(enabled: boolean): Promise<OpenCodeIntegrationState> {
    this.enabled = enabled
    const saved = this.deps.saveEnabled
      ? this.deps.saveEnabled(enabled)
      : updateAppPreferences(this.deps.directory, { opencodeIntegrationEnabled: enabled })
    if (!saved) {
      this.enabled = !enabled
      this.install = {
        state: 'failed',
        configDir: this.configDir(),
        detail: 'The preference could not be saved.'
      }
      return this.getState()
    }
    const state = await this.refreshApi()
    if (!enabled) await this.removeTrackedGuestInstalls()
    return state
  }

  private async removeTrackedGuestInstalls(): Promise<void> {
    if (this.deps.runner === undefined || this.deps.removeGuest === undefined) return
    for (const [key, install] of this.guestInstalls) {
      const configDir = install.configDir || undefined
      await this.deps.removeGuest(this.deps.runner, install.distro, configDir)
      this.guestInstalls.delete(key)
    }
    this.emit()
  }

  /**
   * Installs for one launch. A custom local config returns the overlay
   * `OPENCODE_CONFIG_DIR`; the default directory needs no extra environment.
   */
  async prepareForSession(
    harness: HarnessId,
    target: ExecutionTarget,
    version: string | null
  ): Promise<Record<string, string> | null> {
    if (harness !== 'opencode') return null
    if (target.kind === 'local') {
      await this.refresh(version)
      return Object.keys(this.localLaunchEnv).length > 0 ? this.localLaunchEnv : null
    }
    const api = this.observeVersion(version)
    const key = target.distro.trim().toLowerCase()
    if (!this.enabled) {
      if (this.deps.runner && this.deps.removeGuest) {
        await this.deps.removeGuest(this.deps.runner, target.distro)
      }
      this.guestInstalls.delete(key)
      return null
    }
    if (this.deps.runner === undefined || this.deps.installGuest === undefined) return null
    const result = await this.deps.installGuest(this.deps.runner, target.distro, api)
    this.guestInstalls.set(key, result)
    this.emit()
    return null
  }

  private async refreshApi(): Promise<OpenCodeIntegrationState> {
    await this.syncLocal()
    this.emit()
    return this.getState()
  }

  /**
   * Chooses the canonical config dir or an app-owned overlay for a custom one.
   * The overlay is refreshed on every launch so a user's plugin edits are seen;
   * the source config is never written.
   */
  private async syncLocal(): Promise<void> {
    const source = this.deps.configDir?.() ?? this.sourceConfigDir(this.api)
    const env = this.deps.env ?? process.env
    // OPENCODE_CONFIG_DIR is a 2.x contract. A 1.x client ignores it on
    // Windows, so an overlay would hide the plugin from the process it targets.
    const custom = this.api === 'v2' && Boolean(env.OPENCODE_CONFIG_DIR?.trim())
    const userData = this.deps.userDataDir
    if (!this.enabled) {
      this.install = await this.deps.remove(source)
      if (this.localOverlay) {
        await removeOpenCodeOverlay(this.localOverlay.overlay, this.localOverlay.source)
        this.localOverlay = null
      }
      this.localLaunchEnv = {}
      return
    }
    if (custom && !userData) {
      this.localOverlay = null
      this.localLaunchEnv = {}
      this.install = {
        state: 'failed',
        configDir: source,
        detail: 'A custom OpenCode config needs an app-owned overlay directory.'
      }
      return
    }
    if (custom && userData) {
      const overlay = overlayDirFor(userData, source)
      try {
        await mirrorOpenCodeConfig(source, overlay)
        this.localOverlay = { source, overlay }
        this.install = await this.deps.install(overlay, this.api)
        this.localLaunchEnv = { OPENCODE_CONFIG_DIR: overlay }
      } catch (error) {
        this.localOverlay = null
        this.localLaunchEnv = {}
        this.install = {
          state: 'failed',
          configDir: source,
          detail: error instanceof Error ? error.message : String(error)
        }
      }
      return
    }
    if (this.localOverlay) {
      await removeOpenCodeOverlay(this.localOverlay.overlay, this.localOverlay.source)
      this.localOverlay = null
    }
    this.localLaunchEnv = {}
    this.install = await this.deps.install(source, this.api)
  }

  private sourceConfigDir(api: OpenCodePluginApi = this.api): string {
    return resolveOpenCodeConfigDir({
      env: this.deps.env,
      honorConfigDir: api === 'v2'
    })
  }

  private emit(): void {
    const state = this.getState()
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch {
        // A dead window must not stop installation.
      }
    }
  }

  private configDir(): string {
    return this.deps.configDir?.() ?? this.sourceConfigDir(this.api)
  }
}
