# Terminal interaction parity

iCode is matching Orca's desktop terminal interaction surface for **local and
WSL** sessions. The program plan lives in
`/home/olive/.claude/plans/let-s-draft-a-plan-tender-blanket.md`; Orca's source
reference is `/mnt/d/Development/OrcaProjects/orca`.

This file is the human-readable parity matrix. Every in-scope behavior must be
implemented, covered by an automated check, or explicitly excluded. Grow it
with each slice; R10 converts it to data and fails releases on unwaived red
rows.

## Scope

In scope: desktop local and WSL hosts, tabs and splits, live panes, and
read-only previews.

Excluded: remote/SSH hosts, Orca's native chat/composer, mobile, Orca Browser
and link routing, the resource manager, floating terminals, Windows
administrator mode, cloud pairing, and theme imports.

## Matrix

| ID | Area | Behavior | Status | Coverage |
| --- | --- | --- | --- | --- |
| T-LINK-01 | Links | Detect HTTP(S) URLs in terminal text, with prose/CJK boundaries, IPv6 hosts, and a 2048-character cap | Done | `url-extraction.test.ts` |
| T-LINK-02 | Links | Reconstruct one logical line across soft wraps and map links back to 1-based buffer ranges | Done | `wrapped-line.test.ts`, `transcript-corpus.test.ts` (40/120 columns) |
| T-LINK-03 | Links | Handle OSC 8 hyperlinks; the text provider does not claim OSC-only text | Done | `osc8-nonurl.raw`, xterm provider priority |
| T-LINK-04 | Links | Route only http and https to the OS browser; reject javascript/data/file/relative/malformed/oversized URLs in the renderer and at IPC | Done | `url-routing.test.ts`, main-process schema |
| T-LINK-05 | Links | Plain click opens Open in Browser / Copy Link; Cmd/Ctrl-click opens directly; `openLinksWithModifier` keeps plain clicks inert | Done | UI smoke |
| T-LINK-06 | Links | Reject drags, prior/current selections, shift/alt clicks, and non-primary clicks | Done | `link-gesture.test.ts` |
| T-LINK-07 | Links | A plain click on a link in a mouse-aware TUI opens the action popover and does not also become a PTY mouse report | Done | UI smoke (VT200 mouse tracking) |
| T-LINK-08 | Links | Preview/standalone panes install no link handling (no interaction host) | Done | code path |
| T-SET-01 | Settings | Terminal settings card for font, cursor, scrolling, clipboard, links, find, and quick commands | Planned (R1b) | — |
| T-CMD-01 | Commands | Terminal quick commands from the pane menu (insert and run) | Planned (R1b) | — |
| T-PASTE-01 | Clipboard | PRIMARY selection, middle-click, multiline confirmation, image/file paste, copy-context cap, OSC 52 replay gate | Planned (R1b) | — |
| T-META-01 | Host | OSC 7 live cwd/title, `terminal-meta`, protocol v3, file links, WSL guest paths | Planned (R2) | — |
| T-INPUT-01 | Input | Modified Enter/CSI-u, JIS/Option, mouse encodings, startup DA1 ownership, scroll intent, pane lifecycle | Planned (R3) | — |
| T-IME-01 | Input | Full IME composition and Hangul parity on the pinned xterm beta | Planned (R4) | — |
| T-OUT-01 | Output | ACK credit, renderer parse barrier, write health, hidden restore, render settle | Planned (R5) | — |
| T-PARK-01 | Lifecycle | Parking, cold activation, prewarm, snapshot/restore precedence | Planned (R6) | — |
| T-REND-01 | Rendering | WebGL fallback, images, ligatures, Unicode 11, Arabic shaping, zoom/themes | Planned (R7) | — |
| T-PROC-01 | Shell | Foreground process and OSC 133 shell integration | Planned (R8) | — |
| T-AGENT-01 | Agent | Send selection/context, agent quick commands, waiting guards, continue/fork | Planned (R9) | — |
| T-MATRIX-01 | Program | Data matrix, cross-platform pass, NOTICE and release notes | Planned (R10) | — |

## Transcript corpus

Raw terminal bytes live under `tests/fixtures/terminal/links/`. Each fixture is
written through xterm's real headless parser in
`src/renderer/src/terminal/links/transcript-corpus.test.ts`, so wrapping, wide
cells, and escape handling match production.

Conventions:

- Add a fixture for every matrix row whose behavior depends on terminal bytes.
- Name fixtures by behavior and terminal width, for example
  `url-wrapped-40.raw`.
- Tests pass the terminal width explicitly and use `convertEol: true` so
  line-oriented fixtures stay readable.
- Keep fixtures minimal and deterministic; no timestamps or host-specific text.

## Verification

R1a was verified with `pnpm typecheck`, `pnpm test`, `pnpm build:app`,
`pnpm check:brand`, `pnpm gate:pty`, the host start/verify/reattach/stop gates,
`pnpm smoke:ui`, and `pnpm perf:resize`. The compat probes must run with the
launching session's `ICODE_HOST_*` variables unset so their host directory and
socket stay paired.
