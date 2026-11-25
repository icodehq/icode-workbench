# Privacy at iCode

_Last updated: 2026-11-25._

iCode Workbench is local-first. The app itself collects **no analytics, no telemetry, no usage events, no account IDs, no install IDs, and no device IDs**. Prompts, code, file paths, and conversation IDs do not leave your machine through iCode.

## Every outbound call

| Call | When | What leaves | Where |
|---|---|---|---|
| Update check | On launch and periodically | App version and platform in a standard update request | GitHub Releases (`github.com/icodehq/icode-workbench/releases`) |
| Agent CLI | When you run a harness | Whatever that CLI sends to its vendor and the provider you configured | Your CLI's vendor / your provider |
| Git | When you fetch or push | Repository data | The remote you configured |
| Diagnostics | Only when you choose to copy or export | Exactly what the diagnostics view shows | Wherever you send it |

No other network calls are made by iCode. Local logs and session state stay on your machine.

## How T3 Code compares

T3 Code is another control plane for coding agents. Its telemetry documentation (November 2026) describes a different model: product events are sent to `ingest.t3.codes`, associated with hashed T3 Connect, OpenAI, and Claude account IDs, a stable install ID, and a per-device ID; events are forwarded to PostHog. Telemetry is on by default, with an opt-out via `T3CODE_TELEMETRY_ENABLED=false` or a managed policy. Relay diagnostics go to Axiom and can include the connected machine's name and environment identifiers.

| | T3 Code (per its docs, Nov 2026) | iCode |
|---|---|---|
| Analytics / telemetry on by default | Yes | **None** |
| Hashed OpenAI / Claude account IDs | Yes | **None** |
| Hashed T3 Connect account | Yes | **No account exists** |
| Stable install ID / per-device ID | Yes | **None** |
| Third-party analytics | Events forwarded to PostHog | **None** |
| Prompts / code / file contents | Not collected by default (opt-in feedback can attach text) | Not collected |
| Relay diagnostics | Axiom (machine name, environment IDs) | **None** |
| Opt-out | Env var / managed policy | **N/A — nothing to opt out of** |

Source: T3 Code's `docs/user/telemetry.md` at `github.com/pingdotgg/t3code`. T3 Code is not affiliated with iCode; this comparison reflects its documentation as of November 2026 and may change.

## Verify it yourself

- Run `bash scripts/audit-telemetry.sh`. It fails if an analytics SDK or endpoint is added to `src/` or `package.json`.
- Search the source: `grep -RInE "posthog|sentry|amplitude|mixpanel|segment\.io|plausible|umami|bugsnag|datadog|newrelic|google-analytics|googletagmanager" src package.json`
- Watch the app's network calls with Little Snitch, Proxyman, or `lsof -i -P | grep -i icode`. You will see the update check and the agents and providers you configured.

## Policy

iCode will never add telemetry. If that ever changes, it will be opt-in, off by default, and announced in the changelog. A CI check enforces the current state.

## Third-party harnesses

The CLIs you run (Claude Code, Codex, OpenCode, and others) have their own data policies. iCode does not add, proxy, or observe their telemetry. If a harness sends data to its vendor, that is between you and the vendor.

## Diagnostics

iCode's diagnostics are manual. Nothing is sent unless you choose to copy or export it, and the view shows exactly what would leave.
