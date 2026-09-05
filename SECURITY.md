# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/launchsafe/vole/security/advisories/new)
(Security tab → "Report a vulnerability") rather than in a public issue. You should get an initial
response within a few days.

## Scope

Vole is local-first by design: everything documented in the [README](README.md#why-this-exists)
runs on your machine. There is no server, no account, no telemetry, and no network call this
project makes on its own — that's the thing most worth breaking, if it's ever untrue.

What's actually in scope for a report:

- The collector reading a maliciously crafted log file (from Claude Code, Codex, OpenCode, Grok,
  Cursor, Devin, or Antigravity) in a way that escapes its expected parsing — e.g. writing outside
  `~/.vole/`, executing anything, or crashing in a way that isn't just a bad row skipped.
- The MCP server (`pnpm mcp`) or any CLI (`top`, `pr`, `digest`, `statusline`) doing anything other
  than reading the local database and answering on stdout/stdin.
- A vulnerability in `apps/mac` — the SwiftUI app, or the embedded collector binary it spawns
  (`apps/mac/scripts` / `packages/core/scripts/build-sea.mjs`) — that affects anything beyond the
  current user's own account.
- Anything that would make Vole exfiltrate data it's not supposed to, given the project reads
  usage logs and (for Cursor/Devin/OpenCode) other tools' local databases directly.

Out of scope: the accuracy of a cost or token figure (that's a correctness bug, not a security
one — `pnpm verify` exists for exactly that, and a plain issue is the right place for it), and
anything requiring physical or root access to a machine that's already collecting your logs, which
is a much larger compromise than this project could meaningfully defend against.

## Supported versions

Pre-1.0: only the latest commit on `main` is supported. There are no maintained release branches
yet.
