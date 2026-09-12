# Recent changes

Eleven commits on `fix/purge-retired-rule-anomalies`, branched from `main` at `cd4ca2f`.
Seven fix bugs; four add the Cursor work and the third confidence tier. Every figure
below was measured on a real store, and each fix ships with a test.

**Status:** 83 tests passing, `tsc --noEmit` clean, `pnpm verify` PASS against a live
store, all seven collectors working. Not merged.

---

## Why so many bugs, and where they were

All seven share one root: **data written by other vendors' tools was trusted as if it
had been validated.** Vole's entire input is files it does not control, and its entire
value is being trustworthy about numbers, so that is the seam that mattered.

Three were found only by *running* the software — a passing test suite would never have
revealed them. That is worth noting, because the macOS app has no tests at all.

---

## The fixes

### 1. Retired rules kept reporting verdicts (`e46dbae`)

A rule that is removed from the registry leaves its findings behind forever, and nothing
filters `rule` at read time, so the incident feed kept showing conclusions the current
code could never produce. A rule is usually retired *because it was wrong*, which makes
its rows exactly the ones a user should stop seeing.

On the development store **127 of 147 incidents (86%)** came from rules that no longer
existed. The registry invariant is now enforced on every detect pass — not only when the
rule set changes, since rows left by an older build outlive the epoch that retired them.

### 2. Token counts were never type-checked (`dfc87df`)

Collector interfaces declare usage fields as `number`, but that is a compile-time claim
about JSON parsed at runtime, and `?? 0` guards only null and undefined. Four failures
were reachable from a single malformed line:

| Input | Before |
|---|---|
| An array or boolean | `node:sqlite` cannot bind it — the INSERT threw and **the whole pass aborted**, for every tool |
| The string `"999999"` | `input + output` **concatenated**: stored 9,999,995,000 instead of 1,004,999 and priced it at **$5.00** |
| A negative count | Negative tokens and a **negative cost**, quietly reducing reported spend |
| `1e308` | Survived as REAL and priced to **Infinity**, poisoning every aggregate |

A count is now accepted only if it is a finite, non-negative, safe integer. Out-of-range
is **rejected rather than clamped**, because rows parked at `MAX_SAFE_INTEGER` make
`SUM()` unreadable back out of SQLite — trading one bad row for a store whose every
aggregate throws.

`verify` had the same class of hole: `JSON.parse("null")` succeeds, so a bare `null`
line crashed the very tool users run to confirm the numbers are real.

### 3. A future timestamp froze the app for ~55 seconds (`24a4503`)

The chart's zero-fill ran to `max(nowBucket, max(data buckets))` — bounded by an
untrusted timestamp. One tool with a broken clock writing year 3999 produced roughly
**17 million hourly buckets**, one allocation each. On a view that refreshes every few
seconds that is indistinguishable from a hang. The axis now stops at now; rows beyond it
are still charted, they just no longer stretch it. **47s → 0s.**

### 4. A WAL race killed the collector at startup (`06ade9f`)

`PRAGMA journal_mode = WAL` takes an exclusive lock and, unlike ordinary statements, does
**not** run SQLite's busy handler — so the `busy_timeout` set on the line above never
applied to it. Two collectors opening a fresh store raced, and the loser threw out of
`openDb`, which runs at module scope outside the guard around the first pass. The
process died before its first poll: the monitor was silently down.

Reproduced in 2 of 5 concurrent runs; 0 of 8 after.

The same commit stopped `~/.vole/pricing.json` accepting impossible rates (a negative
rate priced usage *negative*), and clamped a cache countdown that a skewed clock had
rendered as roughly two thousand years.

### 5. A corrupt store reported itself healthy (`bd10895`)

`sqlite3_open_v2` only allocates a connection; it never reads the file. So 8 KB of random
bytes opened "successfully" and the app reported `db: ok`, with the failure surfacing
later as an empty dashboard — which reads as "no usage yet", not "this store is
unreadable".

Requiring a real page read before accepting a handle also fixed a latent bug it exposed:
the READONLY-then-READWRITE fallback only retried when *open* failed, and open never
fails, so a WAL store kept a READONLY handle that cannot create the `-shm` index a WAL
reader needs. Every query returned nothing while the app declared itself healthy.

### 6. Concurrent openers crashed on migrations (`6dc7435`)

`migrate()` read `PRAGMA user_version` and built the pending list *outside* the
transaction that applies them, so read-decide-act was not atomic. Two collectors on a
store needing migration both saw the same version and built the same list; the loser
re-applied migration 1 after the winner had committed it and died on
`UNIQUE constraint failed: schema_migrations.version` — again uncaught, out of `openDb`,
again dead before the first poll.

Found while writing the manual test runbook, which is the only reason it was found at
all. Reproduced in 3 of 6 runs; 0 in 8 rounds of 6 after.

### 7. The app's schema gate drifted from the collector's (`968fd1a`)

The app carries its own `knownSchemaVersion`, and the version gate only works while it
agrees with the collector's newest migration. Adding migrations 29 and 30 left the app
claiming 28, so the branch build greeted the store *its own embedded collector had just
written* with "Store written by a newer Vole" and drew nothing at all. Every panel
empty; the data underneath perfectly fine.

The existing comment already said the two "must move in lockstep" — but a comment asking
a human to remember is not a mechanism, which is exactly how it drifted. A test now reads
the constant out of `DB.swift` and compares it to `LATEST_MIGRATION`.

---

## The features

### The `estimated` confidence tier (`a5828b4`)

A third tier beside `exact` and `activity_only`, plus the `estimation_method` column
(migration 29) that makes it honest. An estimate names the deterministic method that
produced it, so `pnpm verify` can re-run that method against the stored inputs and fail
on a mismatch.

**An estimate that cannot be re-derived exactly from its stated method is a bug, not an
estimate.** That distinction is the entire reason relaxing the original no-estimates
policy was safe, and it is why the tier is not simply a licence to guess.

The tier is additive: rows written before the migration keep `NULL`, and a test asserts
an estimated row cannot leak into an exact total.

This also surfaced a latent migration bug — the version gate was stamped from
`MIGRATIONS[length - 1]`, i.e. array *order* rather than the highest version, so a
migration inserted out of order applied and then stamped the wrong number, and would
re-run on every open forever.

### Cursor: real tokens, from the store Vole was not reading (`8e188ba`, `69cfdc3`, `a8cb3f1`)

Cursor keeps two unrelated local stores and Vole was reading the one without usage. The
attribution database genuinely has no token columns — which is why Cursor was recorded
`activity_only` and documented as having no local token data. The editor's own
`state.vscdb` holds one row per message carrying a real
`tokenCount: { inputTokens, outputTokens }`.

**1,093 messages and 65,007,857 tokens** that were previously invisible, now read
verbatim and tiered `exact`. An independent re-derivation in Python, sharing no code with
Vole, produced the identical figure.

Three things had to be got right:

- **Timestamps are derived.** A message carries no time of its own; only its conversation
  does. Each is placed by its own `createdAt` where present (~18%), otherwise by linear
  interpolation across the conversation's span. Stamping them all at `createdAt` would
  drop ninety-odd calls onto one millisecond and manufacture a burn spike out of nothing.
- **Retired rows had to go.** The old collector's rows use a different `event_key` shape,
  so nothing deduped them against the new ones and they kept counting as calls from a
  source the code no longer reads — 8 phantom calls. Only visible on a store with
  history; a fresh scratch database cannot reveal it.
- **Cursor stopped recording.** Every month from May 2025 to March 2026 carries counts;
  from April 2026 there are none, and the field is still written as a zero. So Cursor is
  an archive, not a live feed: historical turns are `exact`, later ones `activity_only`
  (3,810 of them, also previously invisible). Inferring a count from text length would
  invent precisely the number Cursor stopped publishing.

The collector now reports staleness directly — *"No token counts recorded for 179 days …
this total will not grow"* — because a parser that still works against a source that has
gone quiet is otherwise indistinguishable from a healthy one.

---

## Schema changes

| Migration | Change |
|---|---|
| **29** | Adds `usage_events.estimation_method` (nullable). Existing rows keep `NULL`, which is correct — everything written before it is `exact` or `activity_only`, and neither carries a method. |
| **30** | Removes Cursor rows written by the retired attribution collector, scoped by `raw_ref` so no other build's rows are touched. They carry no tokens, so no measurement is lost. |

A store migrated to 30 **cannot be written by an older Vole** — the version gate refuses
it by design. A build from before this branch will still *display* such a store but its
collector will refuse to write, so keep a pre-migration backup if you need to move back.

---

## A note on testing

Two tests written during this work were thrown away and rewritten. They asserted against
a local re-implementation of the rule rather than calling the collector, so they would
have passed no matter how broken the real code was. The replacement drives the real
collector against a synthetic store, and was confirmed by mutation — deliberately
breaking the tiering logic makes it fail.

That check is worth applying to any test that looks like it is passing for free.
