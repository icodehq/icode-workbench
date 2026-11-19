import {
  CLAUDE_PROVIDER_DELIVERY,
  PROVIDER_KEY_ENV,
  providerLaunchPlan,
  type ProviderLaunchInput
} from './domain/provider-recipes'

export { CLAUDE_PROVIDER_DELIVERY, PROVIDER_KEY_ENV }
export type { ProviderLaunchInput }

/**
 * Turns a provider into the inputs a harness understands.
 *
 * iCode launches every session, so a provider is injected at process start and
 * never written into the user's global config. Each harness has its own
 * mechanism, described by the recipe registry:
 *
 *   Claude Code  ANTHROPIC_* environment + `--model` (the hook overlay stays keyless)
 *   Codex        `-c` TOML overrides + ICODE_PROVIDER_API_KEY
 *   OpenCode     OPENCODE_CONFIG_CONTENT inline JSON
 *
 * The translator is pure and shared with the Settings preview. The preview
 * passes a masked key; it never has the real one.
 */

export type ProviderLaunchSpec = {
  args: string[]
  env: Record<string, string>
  /**
   * Fallback only: environment for a merged Claude `--settings` overlay.
   * Empty in the normal env-first path.
   */
  claudeEnv: Record<string, string>
}

export function nativeLaunchSpec(): ProviderLaunchSpec {
  return { args: [], env: {}, claudeEnv: {} }
}

export function providerLaunchSpec(provider: ProviderLaunchInput): ProviderLaunchSpec {
  const plan = providerLaunchPlan(provider)
  return {
    args: plan.args,
    env: plan.env,
    claudeEnv: plan.claudeEnv ?? {}
  }
}

/**
 * Fallback only: applies provider env to an existing Claude overlay document.
 *
 * The hook overlay and the provider must arrive in one `--settings` file:
 * multiple overlays do not deep-merge `env` (measured), so passing two would
 * silently drop whichever env block is read first.
 */
export function withClaudeProviderEnv(
  overlay: Record<string, unknown>,
  env: Record<string, string>
): Record<string, unknown> {
  if (Object.keys(env).length === 0) return overlay
  const existing =
    overlay.env !== null && typeof overlay.env === 'object' && !Array.isArray(overlay.env)
      ? (overlay.env as Record<string, unknown>)
      : {}
  return { ...overlay, env: { ...existing, ...env } }
}
