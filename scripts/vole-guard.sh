#!/bin/sh
# The budget guard, as a Claude Code PreToolUse hook.
#
# This wrapper exists for one reason: EXIT CODES. A PreToolUse hook blocks a tool call
# by exiting 2, and running the guard through `pnpm run` collapses that to 1 — which the
# hook contract treats as a non-blocking error, so every hard cap would be silently
# ignored while appearing to be installed. `exec` hands the process over so the guard's
# own exit code is what Claude Code sees.
#
# Registered by `pnpm budget --install-hook`.
cd "$(dirname "$0")/.." || exit 0   # fail open: never block because of our own plumbing
exec node --import tsx packages/core/src/cli/guard.ts "$@"
