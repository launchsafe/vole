## What this changes

<!-- One or two sentences. If it fixes an issue, link it. -->

## Why

<!-- The problem being solved. For a bug fix, what the wrong behaviour was. -->

## How it was verified

<!-- Delete what does not apply. Numbers beat assertions. -->

- [ ] `pnpm test`
- [ ] `pnpm verify` against a real store
- [ ] `swift build --package-path apps/mac`
- [ ] Ran the app and looked at the affected screen

## Checklist

- [ ] No number is estimated. Absent data stays `NULL`, never `0`.
- [ ] Collectors remain idempotent — re-reading the same source changes nothing.
- [ ] No prompt or tool content is stored.
