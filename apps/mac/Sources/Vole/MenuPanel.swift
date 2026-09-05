import SwiftUI
import AppKit

// MARK: - Shared bits

/// The range filter — the standard segmented control. On macOS 26 the system renders
/// it as Liquid Glass in the floating toolbar automatically; no custom glass, and no
/// glass-on-glass. (Per HIG: use the standard component, keep glass off content.)
struct RangeSelector: View {
    @Binding var selection: DateRange
    var body: some View {
        Picker("Range", selection: $selection) {
            ForEach(DateRange.allCases) { Text($0.rawValue).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }
}

/// Grouped-content container — the standard inset fill. The panel itself is the
/// one glass surface (a MenuBarExtra window); content sits on a plain fill, never
/// nested glass. (HIG: no glass-on-glass, no content inside Liquid Glass.)
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background.secondary,
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct ConfidenceBadge: View {
    let c: String
    init(_ c: String) { self.c = c }
    var body: some View {
        Text(Labels.confidence(c))
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background((c == "exact" ? Color.green : Color.secondary).opacity(0.15), in: Capsule())
            .foregroundStyle(c == "exact" ? Color.green : Color.secondary)
    }
}

/// First-run / no-data state: the collector isn't feeding the database yet. A bundled
/// app runs its own collector already — telling that user to run a pnpm command asks
/// them to do something they have no Node, no pnpm and no terminal to do, so only an
/// unbundled dev build (`swift run`) shows the command.
struct SetupCard: View {
    let command: String
    let path: String
    @State private var copied = false
    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 7) {
                if Collector.isEmbedded {
                    Label("Setting up", systemImage: "bolt.horizontal.circle")
                        .font(.subheadline.weight(.semibold))
                    Text("Vole is starting its collector. This takes just a few seconds.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                } else {
                    Label("Waiting for the collector", systemImage: "bolt.horizontal.circle")
                        .font(.subheadline.weight(.semibold))
                    Text("Vole reads a local database the collector writes. Start it, then keep it running:")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        Text(command)
                            .font(.callout.monospaced())
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(.background.tertiary, in: RoundedRectangle(cornerRadius: 6))
                        Button {
                            copyToPasteboard(command)
                            withAnimation { copied = true }
                        } label: {
                            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        }
                        .buttonStyle(.borderless)
                        .help("Copy")
                    }
                    Text(path)
                        .font(.caption2.monospaced()).foregroundStyle(.tertiary)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
        }
    }
}

/// The collector ran once but hasn't checked in recently — it probably stopped.
struct StaleBanner: View {
    let since: Date
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text("Collector last checked in at \(Fmt.clock(Int(since.timeIntervalSince1970 * 1000))) — it may have stopped.")
                .font(.caption)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct SectionCaption: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
    }
}

/// Bar sparkline of the last 24 buckets — no chart library needed.
struct Sparkline: View {
    let points: [TimePoint]
    var body: some View {
        let vals = Array(points.suffix(24)).map(\.total)
        let mx = max(vals.max() ?? 1, 1)
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(vals.enumerated()), id: \.offset) { _, v in
                let f = Double(v) / Double(mx)
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.accentColor.opacity(0.35 + 0.65 * f))
                    .frame(height: max(3, 26 * f))
            }
        }
        .frame(height: 26)
    }
}

// MARK: - The menu-bar panel

struct MenuPanel: View {
    @Bindable var store: Store
    @Environment(\.openWindow) private var openWindow
    @AppStorage("vole.section") private var section = DashSection.dashboard.rawValue

    /// Open the window; if `pane` is given, switch it there (shared @AppStorage,
    /// so it also moves an already-open window).
    private func open(_ pane: DashSection? = nil) {
        if let pane { section = pane.rawValue }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "dashboard")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            switch store.collectorStatus {
            case .noData:
                SetupCard(command: store.collectCommand, path: store.dbPath)
            case .stale(let since):
                StaleBanner(since: since)
                hero
                tools
            case .live:
                hero
                tools
            }

            Divider()
            footer
        }
        .padding(12)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Vole").font(.headline)
            Spacer()
            RangeSelector(selection: $store.range)
                .controlSize(.small)
                .frame(maxWidth: 190)
        }
    }

    private var hero: some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                SectionCaption(text: "Tokens · \(store.range.rawValue)")
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(Fmt.compact(store.summary.tokens))
                        .font(.system(size: 30, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .animation(.default, value: store.summary.tokens)
                    Text(Fmt.money(store.summary.cost))
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                        .animation(.default, value: store.summary.cost)
                }
                Sparkline(points: store.series).padding(.top, 2)
            }
        }
    }

    private var tools: some View {
        let rows = store.summary.byTool.filter { $0.tokens != nil }.prefix(5)
        let mx = max(rows.map { $0.tokens ?? 0 }.max() ?? 1, 1)
        return Card {
            if rows.isEmpty {
                Text("No activity").font(.caption).foregroundStyle(.secondary)
            } else {
                VStack(spacing: 6) {
                    ForEach(Array(rows)) { t in
                        HStack(spacing: 7) {
                            ToolIcon(tool: t.tool, size: 14)
                            Text(Labels.toolShort[t.tool] ?? t.tool)
                                .font(.caption).foregroundStyle(.secondary)
                                .frame(width: 54, alignment: .leading)
                            GeometryReader { geo in
                                Capsule().fill(Pal.series(t.tool))
                                    .frame(width: geo.size.width * Double(t.tokens ?? 0) / Double(mx))
                                    .frame(maxHeight: .infinity, alignment: .center)
                            }
                            .frame(height: 4)
                            Text(Fmt.compact(t.tokens))
                                .font(.caption.monospacedDigit())
                                .frame(width: 46, alignment: .trailing)
                        }
                    }
                }
            }
        }
    }

    private var footer: some View {
        VStack(spacing: 1) {
            MenuRow(title: "Open Vole") { open() }
            MenuRow(title: "Settings", shortcut: "⌘,") { open(.settings) }
                .keyboardShortcut(",", modifiers: .command)
            Divider().padding(.vertical, 3)
            MenuRow(title: "Quit Vole", shortcut: "⌘Q") { NSApp.terminate(nil) }
                .keyboardShortcut("q", modifiers: .command)
        }
    }
}

/// A native-menu-style row: full-width, left-aligned, accent highlight on hover,
/// optional shortcut hint on the trailing edge.
struct MenuRow: View {
    let title: String
    var shortcut: String? = nil
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                Spacer(minLength: 12)
                if let shortcut {
                    Text(shortcut)
                        .foregroundStyle(hovering ? .primary : .secondary)
                }
            }
            .font(.callout)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .foregroundStyle(hovering ? .white : .primary)
            .background(hovering ? Color.accentColor : .clear,
                        in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}
