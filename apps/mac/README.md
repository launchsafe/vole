# Vole — the macOS app

The product's only UI: a SwiftUI menu-bar app with a dashboard window. Same data, same
rules, same confidence system as the collector — read straight from the SQLite database
it writes to `~/.vole/vole.db`.

Menu-bar first (no Dock icon until you open the dashboard window).

## Run

```bash
# 1. keep the collector running — only needed here; a bundled .app runs its own (see Package)
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
./bundle.sh              # → build/Vole.app  (ad-hoc signed, local use only)
./bundle.sh --open       # also launches it
./bundle.sh --release    # Developer ID signed, notarised, stapled, + a .dmg — see the
                          # script's header comment for one-time cert/credential setup
VERSION=0.2.0 ./bundle.sh
```

Either way, `bundle.sh` also builds the collector as one self-contained executable
(`packages/core/scripts/build-sea.mjs` — esbuild bundles it, then Node's own
`--experimental-sea-config` turns it into a binary with no Node install required) and embeds
it at `Contents/MacOS/vole-collector`. `Collector.swift` spawns it when the app finishes
launching and stops it on a normal quit; `swift run` has no such binary next to it, so it's a
silent no-op there and you keep running `pnpm collect` yourself, per **Run** above.

The icon lives in `Icon/` — one geometry in `build.mjs` (`node Icon/build.mjs` previews the
treatments, `--emit` writes `Vole.icns` and `Sources/Vole/Resources/AppIcon.png`). The
transparent `Icon/glyph.svg` is the master to drop into Icon Composer for a Liquid Glass build.

## Layout

| File | What |
|---|---|
| `DB.swift` | Read-only SQLite + the read models ported from `packages/core/src/queries.ts` |
| `Store.swift` | `@Observable` state, re-reads every 3s |
| `Theme.swift` | Palette (light/dark), formatters, labels — ported from the web `lib/` |
| `MenuPanel.swift` | The menu-bar panel: hero tokens/cost, sparkline, per-tool bars, latest incident |
| `DashboardView.swift` | The window: KPI row, incident-annotated timeline (Swift Charts), incident list, sortable breakdown table |
| `VoleApp.swift` | `MenuBarExtra` + `Window` scenes, activation-policy switching, Dock icon |
| `Collector.swift` | Spawns/stops the embedded collector binary, when a bundled app has one |
| `Icon/build.mjs` | App-icon artwork — one geometry, all treatments, `.icns` + `AppIcon.png` |
| `Info.plist` / `bundle.sh` | `.app` bundle template + assembler |

## Not done yet

- **Launch at login**, **Notification Center widget**.
- **Seed-data toggle** — the app reads `source = 'live'` only (it still shows a "demo data" badge if seed rows exist).
- **Live sessions, session drill-down, digest, what-if** — complete in `packages/core` and
  available via `pnpm top`, `pnpm digest` and the MCP server; not drawn here yet. See
  [ROADMAP.md](../../docs/ROADMAP.md).
