<div align="center">

<img src="apps/mac/Icon/AppIcon.appiconset/icon_512x512@2x.png" alt="Vole" width="112" height="112">

# Vole

**Local-first usage, cost and anomaly monitor for AI coding agents.**

[![CI](https://github.com/launchsafe/vole/actions/workflows/ci.yml/badge.svg)](https://github.com/launchsafe/vole/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS 26+](https://img.shields.io/badge/platform-macOS%2026%2B-lightgrey.svg)](#install)
[![Node: 22+](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen.svg)](#install)

</div>

Developers now run several AI coding agents side by side. Each burns tokens independently, and none
of them tells you when one has gone wrong — stuck in a tool loop, retrying against a broken API, or
quietly re-reading the same 200K-token context forty times.

Vole reads the logs those tools already write to disk, normalises them into one schema, and flags
the misbehaviour. Existing tools answer *"how much did I spend?"*; Vole answers *"is anything going
wrong right now?"* and shows the spend as a side effect.

Everything runs locally. No scraping, no cloud APIs, no account to log into, and no prompt or tool
content is ever stored.

![The Vole dashboard: token and cost figures above a 30-day incident-annotated timeline stacked by tool](docs/images/dashboard.png)

<div align="center"><sub>Demo data (<code>pnpm seed</code>) — real logs are sparse and rarely fill a 30-day view this evenly.</sub></div>

## Install

**[Download Vole for macOS](https://github.com/launchsafe/vole/releases/latest)** — signed,
notarised, and requires nothing else installed. Open the `.dmg` and drag Vole to Applications.
Requires macOS 26 or later (Apple silicon).

The app embeds its own collector and starts it itself. After the first launch it lives in the
menu bar, and updates itself in place — each release publishes a SHA-256 beside the archive,
and an update without one is never installed silently.

### Building from source

Requires **Node ≥ 22**, **pnpm**, and **Xcode 26**. Built and tested on macOS 26 (arm64).

```bash
git clone https://github.com/launchsafe/vole && cd vole
pnpm install
pnpm app:bundle      # build Vole.app and open it
```

To work on the app from source instead, run the collector separately:

```bash
pnpm collect         # parse the logs, poll every 5s
pnpm app             # swift run, unbundled
```

Prefer a populated UI before pointing it at real logs? `pnpm seed` writes 30 days of synthetic
history that exercises every rule, and `pnpm seed:purge` removes it. Seed rows are tagged
`source='seed'`, charted separately, and never share a statistical baseline with live data.

## Supported tools

Different tools expose wildly different data, and Vole never papers over the difference.

| Tool | Tokens | Cost | Source on disk |
|---|---|---|---|
| **Claude Code** | Exact | Exact | `~/.claude/projects/**/*.jsonl` |
| **OpenCode** | Exact | Exact (its own, per provider) | `~/.local/share/opencode/opencode.db` |
| **Codex CLI** | Exact | — no published rate | `~/.codex/sessions/**/rollout-*.jsonl` |
| **Grok CLI** | Exact | — no published rate | `~/.grok/logs/unified.jsonl` |
| **Cursor** | Exact to Mar 2026, then none | — no model recorded per message | `…/Cursor/User/globalStorage/state.vscdb` |
| **Devin** | None recorded locally | — | `~/Library/Application Support/Devin/…` |
| **Antigravity** | None recorded locally | — | `~/.gemini/antigravity-ide/brain/<id>/` |

**Three tiers, and a number is never guessed.** `exact` is read verbatim from the tool's own logs.
`estimated` is derived by a named, deterministic method recorded in `estimation_method`, which
`pnpm verify` re-runs against the stored inputs and fails on any mismatch — an estimate that cannot
be re-derived from its stated method is a bug, not an estimate. `activity_only` means the tool
records that a call happened and nothing that could support even a falsifiable estimate; those rows
carry NULL tokens and are excluded from every token and cost aggregate, so they cannot drag an
average. Every total states which tier or tiers it sums.

Estimating Cursor's tokens from lines of code was considered and rejected, and still is — but it
turned out not to be needed. Cursor does record real counts locally, in the editor's own
`state.vscdb`, not in the attribution database this project read for a long time. Those are read
verbatim and tiered `exact`; cost stays unknown because a Cursor message records no model.

**Cursor's local counts stop around April 2026.** Measured month by month: every month from May
2025 to March 2026 carries token counts, and from April 2026 there are none — 59 assistant turns
that April, more than March had, not one with a count. The field is still written, as a zero. So
Cursor is an *archive*, not a live feed: turns up to the cutoff are `exact`, later ones are
`activity_only` — the call demonstrably happened, the tool no longer records what it cost. The
collector says so on every pass rather than letting a frozen total look healthy. Why each
tool is what it is, with real payloads and the traps in each format, is in
[DATA-SOURCES.md](docs/DATA-SOURCES.md).

## The app

A menu-bar item shows live tokens (or cost, or just the mark), tinted while an incident is open.
Click it for a panel with the headline figures, a sparkline and per-tool bars. Open the dashboard
for the full view.

The signature element is the **incident-annotated timeline**: tokens stacked per tool in each
tool's colour, with a hover callout naming the bucket, its tokens and any incidents that fired
there — so a spike and its cause are one glance rather than a chart and a list to correlate by
hand. Quiet days render as zero buckets, never as missing ones.

Vole asks for **one** optional permission — notifications, for an alert the moment a critical
incident fires. Nothing else: every source it reads is a dotfile in your own home or
`~/Library/Application Support`, so Full Disk Access is not required and is not requested.

The app updates itself: a release publishing a checksummed archive offers a one-click install that
verifies the published SHA-256 before swapping the running bundle. A release without a checksum
never silent-installs.

## Command line and MCP

Everything the app knows, from the terminal, across every tool.

```bash
pnpm top          # htop for agents: live sessions, context vs window, tok/min, cache countdown
pnpm digest       # "your agent week" as markdown (--range=24h|7d|30d|all, --json)
pnpm pr           # markdown table of agent usage on the current branch, for a PR description
pnpm statusline   # one line for a status bar
pnpm mcp          # stdio MCP server over the same queries
pnpm optimize     # waste findings with paste-ready fixes (--apply; re-checked after 3 days)
pnpm budget       # spend caps; --install-hook wires the hard stop into Claude Code
pnpm models       # per-model efficiency, one row per confidence tier
pnpm checkup      # per-tool health: is any source still read but no longer measuring?
```

`checkup`'s reason for existing is staleness. A collector whose parser still works against a
tool that changed what it writes looks exactly like a healthy one: it reports success,
inserts rows, and its number quietly stops growing. That has already happened here — Cursor
stopped recording token counts around April 2026 — so a source still being read that has
measured nothing for 30 days is flagged rather than passed.

`optimize` proposes; it never applies without `--apply`, and only one finding class has a
fix it can safely make on its own. Anything it does apply is journaled, re-measured after
three days, and reverted automatically if it did not help.

`budget` enforces hard caps through a Claude Code `PreToolUse` hook (and OpenCode's
`permission.ask`); Codex exposes no hook mechanism, so caps are advisory there. Estimated
cost counts toward a cap by default — a cap that ignored unmeasured spend would fail exactly
when it matters.

The MCP server exposes `vole_summary`, `vole_live_sessions`, `vole_session`, `vole_incidents`,
`vole_breakdown`, `vole_whatif`, `vole_budget` and `vole_digest`, so an agent can ask what its own session has
cost, how full its context is, and whether Vole has flagged it — which makes cost-aware agents
possible. Register it with any tool that speaks MCP:

```bash
claude mcp add vole -- pnpm --silent --dir /path/to/vole mcp
```

Nothing leaves the machine: the server reads the local database and answers on stdout.

## Anomaly rules

| Rule | Fires when |
|---|---|
| `billable_burn_spike` | A 10-minute window costs >3× that session's typical window |
| `repeat_call_loop` | ≥45 calls in 5 minutes while output stays flat |
| `error_storm` | >20% error ratio over 15 minutes, with ≥5 errors |
| `rate_limit_pressure` | Codex reports >80% of its quota consumed |
| `context_pressure` | A call carried ≥80% of the model's context window |

Two design details that matter. **Baselines are leave-one-out** — a window is compared against the
median of all *other* windows, because a plain median lets a lone spike drag up the baseline it is
measured against and hide inside it. And **loop detection needs two signals**: high call volume
alone also describes a productive burst, so the rule looks for many calls where output stays flat
while cache reads climb. See [ARCHITECTURE.md](docs/ARCHITECTURE.md#detection-design).

## Cost model

Cost is **equivalent API value at list price** — what this usage *would* have cost through the API.
On a subscription plan you are not billed per token, and the UI says so.

```
cost = ( input·I + write5m·I·1.25 + write1h·I·2 + cacheRead·I·0.1 + output·O ) / 1e6
```

Rates are data, not code:
[`packages/core/src/data/pricing.json`](packages/core/src/data/pricing.json), versioned with
`effective_from`. A per-installation `~/.vole/pricing.json` merges over it, so a new model can be
added without a release — and rows stored before that model had a rate are repriced retroactively,
so history updates too. Unknown models return `NULL`, never `0`.

## Verifying it works

```bash
pnpm test     # unit tests: rules, queries, bucketing, confidence invariants
pnpm verify   # reconciles every stored row against its own source record
```

`pnpm verify` re-implements the cost formula independently, so a bug in the product's own pricing
module cannot cancel itself out. It compares per record rather than per total — totals drift while
a session is live, so a total-vs-total check can neither prove nor disprove correctness — and it
fails on an empty store, so a vacuous PASS can never happen.

## Documentation

| Guide | For |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map, schema, the idempotency contract, detection design |
| [DATA-SOURCES.md](docs/DATA-SOURCES.md) | What every tool writes to disk, with real samples and traps |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, commands, debugging recipes, testing philosophy |
| [EXTENDING.md](docs/EXTENDING.md) | Add a tool, a rule, a model rate, or a panel in the app |
| [DECISIONS.md](docs/DECISIONS.md) | How it was built, and the bugs that shaped it |
| [ROADMAP.md](docs/ROADMAP.md) | Ranked next steps and good first issues |

`pnpm docs:pdf` renders the whole set as a single bookmarked PDF.

## Known limitations

- **Devin and Antigravity record no tokens locally.** Their coverage is deliberately shallow
  because the data genuinely is not there — documented rather than disguised. (Cursor was in this
  list until its real counts were found in `state.vscdb`; it is now `exact`.)
- **Cursor message times are partly derived.** About 18% of Cursor messages carry their own
  timestamp and are used as-is; the rest are placed evenly across their conversation's span, since
  only the conversation records a time. Token counts are exact either way; the placement is derived.
- **Cursor no longer records tokens locally** (see above). Recent Cursor usage appears as
  `activity_only` calls, and the exact total is historical and will not grow.
- **`is_error` covers API errors only.** Failed *tool* results inside a turn are not yet correlated
  back to the assistant message that issued them, so `error_storm` under-counts on live data.
- **Generation speeds are lower bounds** for Claude Code, Codex and Grok — the gap from input to
  completed response includes queue time. OpenCode reports real spans. Every figure prints which
  it is.
- **Context windows resolve only for first-party model ids.** Local and proxied models show a
  context size but no window, and never trip `context_pressure`.
- **Antigravity timing is approximate** — file mtimes, not real timestamps.
- **The schema carries some unused tables.** They are empty and nothing reads them; they stay so
  an existing store keeps opening rather than tripping the version gate on downgrade.

## Contributing

Contributions are welcome — [CONTRIBUTING.md](CONTRIBUTING.md) has setup, the pre-PR checks, and
the two rules that shape every review here: *never invent a number*, and *every collector is
idempotent*. Bugs and feature requests go in
[issues](https://github.com/launchsafe/vole/issues);
[ROADMAP.md](docs/ROADMAP.md#good-first-issues) lists good first ones.

## License

MIT — see [LICENSE](LICENSE).
