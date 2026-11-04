# Contributing to iCode

## Prerequisites

- Node 24.x (`.nvmrc` pins 24.15.0) and Corepack with pnpm 11.16.0.
- Linux or WSL2 for development; WSLg for the GUI on Windows.
- Docker for building the WSL Host artifacts.

```bash
pnpm install
```

`pnpm install` runs `config/scripts/rebuild-native.cjs`. On Linux it rebuilds
`node-pty` against the pinned Electron ABI; Windows and macOS use node-pty's
Node-API prebuilds and skip the rebuild. The packaged Linux artifact is staged
separately against glibc 2.35.

## Repository layout

| Path | Responsibility |
|---|---|
| `src/` | Application: `main`, `host`, `preload`, `renderer`, `shared` |
| `config/` | Tooling configuration: TypeScript, Vitest, electron-builder |
| `config/scripts/` | Native rebuild, Host bundle, brand guard |
| `config/scripts/wsl/` | WSL Host artifact build, verify, and prepare scripts |
| `resources/build/` | Packaging assets: application icons |
| `tests/compat/` | Compatibility gates and UI/feature smoke tests |
| `tests/wsl/` | WSL Host artifact selftests and smokes |
| `out/`, `dist/`, `artifacts/` | Generated output and machine-local evidence; never committed |

Invoke package scripts from the repository root. A few harnesses resolve
`artifacts/...` from the current working directory, and the packaging scripts
resolve the repository from their own location.

## Everyday commands

```bash
pnpm dev
pnpm typecheck
pnpm test
pnpm test:watch
pnpm perf:scm
pnpm build          # typecheck + electron-vite + detached Host bundle
pnpm build:app
pnpm build:host
pnpm check:brand
```

`pnpm test` uses `config/vitest.config.mts`; its root is pinned to the repository
root so the config works from any working directory.

## Gates and smokes

| Command | Proves | Prerequisites |
|---|---|---|
| `pnpm gate:sqlite` | SQLite transaction, rollback, and WAL behavior in Electron main | build |
| `pnpm gate:pty` | Real `node-pty` shell under Electron-as-Node | build |
| `pnpm gate:host:start` | Host and PTY survive the app exiting | build |
| `pnpm gate:host:verify` | Reattach to the same session and PTY | running host from `gate:host:start` |
| `pnpm gate:reattach` | Fresh app reattaches without a duplicate process | build |
| `pnpm gate:host:stop` | Stops the gate host and cleans evidence | host from `gate:host:start` |
| `pnpm gate:packaged` | Packaged binary runs from `/tmp` with SQLite, native PTY, and unpacked Host | `package:dir` |
| `pnpm smoke:ui` | Packaged UI smoke | packaged build, WSLg |
| `pnpm smoke:claude` | Real Claude Code TUI in a session | packaged build, Claude Code |
| `pnpm smoke:worktree` | Two isolated sessions, relaunch, discard | packaged build, Git |
| `pnpm smoke:features` | Changes view, stage, commit, amend | packaged build |
| `pnpm smoke:projects` | Project onboarding | packaged build |
| `pnpm smoke:scm` | Source Control parity | packaged build |
| `pnpm smoke:activity` | Hook overlay, real Claude, ordering, unread | packaged build, Claude Code |

## Brand guard

```bash
pnpm check:brand
```

The guard scans `src/`, `config/`, `tests/`, `package.json`, `README.md`,
`NOTICE`, `LICENSE`, and this file for legacy brand tokens. A declared scan root
that does not exist is a hard failure, so moving directories cannot silently
shrink coverage. The guard's own file is allow-listed.

## WSL Host artifacts

```bash
pnpm build:wsl-host
pnpm verify:wsl-host
pnpm selftest:wsl-host
pnpm selftest:wsl-prepare
pnpm smoke:wsl-host
pnpm smoke:wsl-host-baselines
```

The artifact tree at `artifacts/wsl-host/linux-x64` contains the Host bundle, a
pinned Node runtime, and `node-pty` compiled against the declared glibc baseline.
Build inputs are pinned by version and checksum; the native artifact is built
twice in independent containers and both hashes must match. Docker is required.
`verify:wsl-host` verifies the tree at `artifacts/wsl-host/linux-x64`; the
selftests and smokes exercise the verifier's rejection paths and a materialized
copy outside the repository.

## Packaging

```bash
pnpm install
pnpm build
pnpm package:dir      # current platform, unpacked
pnpm package:linux    # AppImage, deb, rpm
pnpm package:win      # NSIS installer
pnpm package:mac      # dmg + zip; pass -- --x64 or -- --arm64
pnpm verify:package   # inspect the produced directory
```

Platform configs live in `config/electron-builder.{base,linux,win,mac}.cjs`;
`config/scripts/package.cjs` selects the right one. MSI is removed; NSIS is the
Windows target.

The WSL Host tree is required **only** for Windows packaging. CI builds and
verifies it once on Linux, and the Windows job downloads it.
`config/scripts/wsl/prepare-artifacts.cjs --verify-only` (the packaging default)
never invokes Docker; `--build-if-missing` is the local convenience, and
`--rebuild` replaces a tree deliberately. Linux and macOS packages never ship the
WSL tree.

Linux packaging stages node-pty in the pinned Ubuntu 22.04 (glibc 2.35) image
before electron-builder; `pnpm package:linux` runs
`config/scripts/native/prepare-linux-pty.cjs` automatically. Pass
`--artifact <dir>` to reuse a cached container build, or set
`ICODE_SKIP_NATIVE_STAGE=1` for a local directory build that will not be
shipped. A development `pnpm install` rebuilds node-pty for the workstation
glibc, so packaging always restages the baseline artifact.

Signing is inert without credentials: macOS Developer ID/notarization and Windows
Authenticode/SignPath activate from standard environment variables. Unsigned
builds still produce artifacts and skip those steps.

**Packaging on DrvFs.** `electron-builder` scans pnpm's module tree while
packaging. On a `/mnt/d` checkout that scan did not complete in 20+ minutes;
the same source tree packages in about one minute on ext4. If `pnpm package:dir`
stalls after `searching for node modules`, stage the checkout on a Linux
filesystem (for example `~/src/icode`) or package there and point the gate at the
result:

```bash
ICODE_GATE_PACKAGED_DIR=/path/to/dist/linux-unpacked pnpm gate:packaged
```

`tests/compat/packaged-smoke.cjs` verifies the packaged binary from `/tmp`:
WAL SQLite, the bundled native PTY, and the unpacked Host starting a real session.

`pnpm package:win` produces the Windows NSIS installer on a Windows host. CI
builds it after downloading the verified WSL tree, then runs
`verify-package` and the Windows packaged smoke (`tests/compat/packaged-smoke-win.cjs`),
which covers SQLite, a native PowerShell ConPTY session, the named-pipe Host, and
shutdown.

## Packaged Linux acceptance

```bash
export XDG_CONFIG_HOME=/tmp/icode-work9/profile
export XDG_RUNTIME_DIR=/tmp/icode-work9/runtime   # chmod 700
./dist/linux-unpacked/icode
```

This keeps repositories and sessions out of your normal profile. To clean up,
stop each test session in the UI, quit iCode, then verify the run's Host has exited
(`<profile>/run/meta.json` records its PID) and delete only the temporary
XDG directories. Never delete `~/.config/iCode` unless you intend to remove your
real iCode data.

The packaged acceptance harness runs the Claude TUI smoke in packaged mode:

```bash
ICODE_SMOKE_TARGET=packaged \
ICODE_SMOKE_EXECUTABLE=$PWD/dist/linux-unpacked/icode \
ICODE_SMOKE_ARTIFACTS=$PWD/artifacts/work9 \
node tests/compat/claude-tui-smoke.cjs
```

It checks the visible WSLg window, default first-run profile, real Claude Code
TUI interaction, quit/relaunch with the same incarnation and one PTY spawn,
stop, and cleanup. `node tests/compat/wslg-window-probe.cjs --match iCode`
prints the mapped windows on the WSLg display without any X11 utilities.

## Evidence

Evidence is written under `artifacts/`, which is ignored by Git. Never commit
screenshots, logs, smoke JSON, or artifact trees: they are machine-local outputs,
not product source.

## Before sending a change

```bash
pnpm typecheck && pnpm test && pnpm check:brand
pnpm build
```

Run the gate or smoke that covers the area you changed. For packaging changes,
run `pnpm package:dir` and `pnpm gate:packaged`.
