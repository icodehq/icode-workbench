# Harness providers

iCode can point the Claude Code, Codex, and OpenCode sessions it launches at an
API provider without editing the tools' global configuration. Define a provider
in **Settings → Agent providers**, select one per harness, and the next session
starts with it.

## What iCode does not touch

No provider is written to `~/.claude/settings.json`, `~/.codex/config.toml`, or
the user's OpenCode config. iCode launches the harness, so the connection details
are injected into that process only:

| Harness | Injection |
| --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, the three `ANTHROPIC_DEFAULT_*_MODEL` role models, and exactly one of `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` in the PTY environment, plus `--model` in argv. The existing keyless hook overlay is unchanged. |
| Codex | `-c` TOML overrides for `model_provider`, `model`, `model_providers.icode.*`, `wire_api=responses`, and `env_key`; the key travels in `ICODE_PROVIDER_API_KEY`. |
| OpenCode | `OPENCODE_CONFIG_CONTENT` with an inline `provider.icode` entry; the key travels inside that environment value. |

Credentials are never placed in argv, shell history, or a provider file. The
Settings preview and every IPC payload omit the key.

## Selection and timing

- One selected provider per harness, machine-wide. A provider belongs to exactly
  one harness because the three tools use different protocols and auth.
- **Create** and **restart/wake** resolve the current selection. A running PTY
  keeps the environment it started with; editing a provider does not rewrite a
  live session.
- **Native configuration** means iCode adds nothing.
- A selected provider cannot be removed. Switch that harness to Native
  configuration (or another provider) first.

## Protocols

Protocol conversion is out of scope. A provider must speak the harness's native
format:

- Claude Code: Anthropic Messages-compatible endpoint.
- Codex: OpenAI Responses API-compatible endpoint.
- OpenCode: OpenAI Chat Completions-compatible endpoint.

The curated presets follow this rule. Model IDs and endpoints change; every
field in the form is editable, and the preset date is only a starting point.

## Keys

API keys are encrypted with Electron `safeStorage` (Keychain, DPAPI, or
libsecret/kwallet) before they reach SQLite. On Linux without a keyring,
`safeStorage` may select `basic_text`; iCode detects that and shows a warning,
because it is obfuscation rather than encryption. If the OS key store is
unavailable, saving a provider is refused. A key encrypted under a different
machine or user cannot be read; re-enter it in Settings.

### Development note

The pre-release prototype stored a plaintext `api_key` column under its own
schema. The final store refuses that database shape with an actionable error;
delete the iCode database (it contains only prototype provider rows) and restart
to create the encrypted schema.

## Test connection

**Test** sends one tiny request through the same endpoint construction the
launch path uses (Claude `/v1/messages`, Codex `/responses`, OpenCode
`/chat/completions`) with a 10 s timeout. It costs one token. Results are
sanitized and never include the key.

## WSL and localhost

Selection is machine-wide, but a session runs on its repository's execution
target. A provider pointed at `127.0.0.1` on Windows is not reachable from a WSL
guest unless WSL networking makes it so. Prefer a host reachable from the guest,
or use the mirrored networking mode.

## Terminal host v2

Per-session provider environment required a terminal-host protocol bump (v1 →
v2). On the first launch after upgrading, iCode may stop a detached host from
the previous version if it can prove this profile owns it (matching recorded
endpoint, token file, and PID). Sessions running under that old host end; they
reconcile as exited and can be restarted. If ownership cannot be proven, iCode
refuses and asks you to stop the old process.

## Out of scope

Local routing/gateway, aggregation, MCP/Skills/Prompts management, usage/quotas,
global config writes, per-project selection, and provider injection for Mira's
one-shot runs or commit-message generation. Those paths continue to use the
harness's native configuration.
