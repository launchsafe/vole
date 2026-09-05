# Contributing to Vole

Contributions are welcome — bug fixes, new tool collectors, new anomaly rules, or app panels.

## Setup

```bash
git clone https://github.com/launchsafe/vole
cd vole
pnpm install
```

Requires **Node ≥ 22** and **pnpm**; **Xcode 26** additionally if you're touching `apps/mac`.
Full environment details, every command, and debugging recipes are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Before opening a pull request

```bash
pnpm test       # unit tests — must pass
pnpm typecheck  # must be clean
```

If you touched a collector or the pricing model, also run:

```bash
pnpm verify     # reconciles every stored row against its own source record
```

CI runs the same three on every PR, plus a Swift build for `apps/mac`.

## Two rules that shape every review here

1. **Never invent a number.** A token count is either read verbatim from a tool's own logs
   (`exact`) or it is absent (`activity_only`, `NULL`). There is no "estimated" tier, by policy —
   see [What is real, and what is not](README.md#what-is-real-and-what-is-not) in the README. A PR
   that estimates, guesses, or interpolates a token/cost figure will be asked to remove it.
2. **Every collector must be idempotent.** Events are keyed as `<tool>:<stable id>` under a
   `UNIQUE` constraint, so re-scanning the same logs can never double-count. If your source has no
   natural stable id, derive one deterministically — never a random or time-based key.

## Where to start

- [docs/EXTENDING.md](docs/EXTENDING.md) — the guide for the most common contributions: adding a
  tool, a rule, a model rate, or a panel in the app.
- [docs/ROADMAP.md#good-first-issues](docs/ROADMAP.md#good-first-issues) — ranked next steps and
  good first issues.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map and the idempotency contract, if
  you're not sure where a change belongs.

## Reporting bugs

Open an [issue](https://github.com/launchsafe/vole/issues) — include your tool versions and,
if it's a data problem, the output of `pnpm verify`. For a security vulnerability, see
[SECURITY.md](SECURITY.md) instead of opening a public issue.
