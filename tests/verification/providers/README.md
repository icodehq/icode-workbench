# Provider recipe verification

`src/shared/domain/provider-recipes.ts` implements 19 endpoint-injection
recipes, but only the ids in `PROVIDER_HARNESSES` are shipped in Settings.
Shipping is gated on a hands-on check: install the CLI, point it at the local
mock endpoint through the generated provider plan, and prove the request path,
auth header, and model.

## Run the checks

```sh
# Terminal 1 (or let the test start it)
node tests/verification/providers/mock-server.cjs
# prints: LISTENING <port>

# Terminal 2, on a machine with each CLI installed
ICODE_PROVIDER_LIVE=1 pnpm verify:providers
```

`src/main/providers/provider-live.test.ts` starts the mock server itself, runs
the invocation listed in `INVOCATIONS`, and reports the CLI version. It
currently automates `openclaude`, `qwen-code`, `gemini`, `copilot`, `goose`,
`continue`, `kilo`, `pi`, `omp`, and `mistral-vibe`. The rest need a manual
check until a one-shot flag is confirmed (or, for Aider, a git repository).
Add an invocation once the flag is known.

## Promote a recipe

1. Run the live check and confirm it passes.
2. Record the result in `matrix.json` (status `pass`, CLI version, date).
3. Add the harness id to `PROVIDER_HARNESSES` in
   `src/shared/domain/provider-recipes.ts`.
4. Re-run the provider tests and `pnpm smoke:features`.

A failing recipe stays out of `PROVIDER_HARNESSES`; do not claim it in the UI.

## What the matrix means today

The three existing recipes (`claude`, `codex`, `opencode`) are marked
`existing`. The other sixteen are `pending`. They are implemented and unit
tested, but not yet exercised against an installed CLI, so the Settings picker
does not offer them.
