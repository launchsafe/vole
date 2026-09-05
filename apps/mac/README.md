# Vole — the macOS app

The product's only UI: a SwiftUI menu-bar app with a dashboard window. Same data, same
rules, same confidence system as the collector — read straight from the SQLite database
it writes to `~/.vole/vole.db`.

Menu-bar first (no Dock icon until you open the dashboard window).

## Run

```bash
# 1. keep the collector running (unchanged)
pnpm collect

# 2. from apps/mac
swift run                # launches the menu-bar app
swift run Vole --dump    # headless: print the parsed summary and exit
```

Needs macOS 26+, Xcode 26 toolchain. The UI is built on Liquid Glass (`.glassEffect`,
`GlassEffectContainer`, `.buttonStyle(.glass)`), which is macOS-26 API. No dependencies —
`SQLite3` ships with the OS.

## Package

```bash
./bundle.sh              # → build/Vole.app  (release build, ad-hoc signed)
./bundle.sh --open       # also launches it
VERSION=0.2.0 ./bundle.sh
```

Ad-hoc signing is fine for local use; real distribution still needs a Developer
ID + notarisation. The icon lives in `Icon/` — one geometry in `build.mjs`
(`node Icon/build.mjs` previews the treatments, `--emit` writes `Vole.icns` and
`Sources/Vole/Resources/AppIcon.png`). The transparent `Icon/glyph.svg` is the
master to drop into Icon Composer for a Liquid Glass build.

## Layout

| File | What |
|---|---|
| `DB.swift` | Read-only SQLite + the read models ported from `packages/core/src/queries.ts` |
| `Store.swift` | `@Observable` state, re-reads every 3s |
| `Theme.swift` | Palette (light/dark), formatters, labels — ported from the web `lib/` |
| `MenuPanel.swift` | The menu-bar panel: hero tokens/cost, sparkline, per-tool bars, latest incident |
| `DashboardView.swift` | The window: KPI row, incident-annotated timeline (Swift Charts), incident list, sortable breakdown table |
| `VoleApp.swift` | `MenuBarExtra` + `Window` scenes, activation-policy switching, Dock icon |
| `Icon/build.mjs` | App-icon artwork — one geometry, all treatments, `.icns` + `AppIcon.png` |
| `Info.plist` / `bundle.sh` | `.app` bundle template + assembler |

## Not done yet

- **Notarisation** — `bundle.sh` ad-hoc signs only; no Developer ID, no `.dmg`.
- **Collector as a sidecar** — you still start `pnpm collect` yourself.
- **Launch at login**, **Notification Center widget**. (Incident notifications come from the collector.)
- **Seed-data toggle** — the app reads `source = 'live'` only (it still shows a "demo data" badge if seed rows exist).
- **Live sessions, session drill-down, digest, what-if** — complete in `packages/core` and
  available via `pnpm top`, `pnpm digest` and the MCP server; not drawn here yet. See
  [ROADMAP.md](../../docs/ROADMAP.md).
