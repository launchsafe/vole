import SwiftUI
import AppKit
import UserNotifications

@main
struct VoleApp: App {
    @State private var store = Store()
    @State private var updateChecker = UpdateChecker()
    @AppStorage("vole.theme") private var theme = "system"
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    /// A first-ever launch presents the dashboard for the same reason the menu-bar
    /// panel's "Open Dashboard" action does (see MenuPanel.swift) — a brand-new user's
    /// only action so far is a Finder double-click, and a menu-bar-only app with no
    /// window and no Dock icon looks exactly like it failed to open. Every launch after
    /// this one goes back to the lightweight menu-bar-only default.
    private static let openDashboardAtLaunch: Bool = {
        let key = "vole.hasLaunchedBefore"
        let firstLaunch = !UserDefaults.standard.bool(forKey: key)
        if firstLaunch { UserDefaults.standard.set(true, forKey: key) }
        return CommandLine.arguments.contains("--dashboard") || firstLaunch
    }()

    private var scheme: ColorScheme? {
        switch theme { case "light": return .light; case "dark": return .dark; default: return nil }
    }

    init() {
        // Needed once for incident notifications to actually show up. Guarded: a bare
        // `swift run` binary has no bundle identifier, and UNUserNotificationCenter
        // throws (not just fails) for a process without one.
        if Bundle.main.bundleIdentifier != nil {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        #if DEBUG
        runSelfCheck()
        #endif
        // Headless sanity check against the real database: `swift run Vole --dump`.
        if CommandLine.arguments.contains("--dump") {
            let db = DB()
            let s = db.summary(.h24)
            print("db: \(db.opened ? "ok" : "FAILED") \(db.path)")
            print("24h  calls=\(s.calls)  tokens=\(s.tokens)  cost=\(Fmt.money(s.cost))  sessions=\(s.sessions)")
            for t in s.byTool { print("  \(t.tool): calls=\(t.calls) tokens=\(Fmt.compact(t.tokens)) conf=\(t.confidence)") }
            print("incidents(7d)=\(db.anomalies(.d7).count)  buckets(24h)=\(db.timeseries(.h24).count)  breakdown=\(db.breakdown(.all).count)")
            print("refresh interval = \(RefreshInterval.saved)s")
            exit(0)
        }
        // Read-model parity dump — the CI contract twin of
        // packages/core/src/cli/readmodel-dump.ts. The Swift reader is an
        // independent implementation of the same SQL, which is exactly why it
        // drifts; this output is diffed against the TS side's in CI.
        if CommandLine.arguments.contains("--dump=readmodel") {
            print(DB().readModelDump())
            exit(0)
        }
        // Dock / ⌘-Tab / About icon — only for `swift run`, where an unbundled binary has
        // no Info.plist to name one. Inside the .app this must NOT run: assigning a raw
        // NSImage overrides CFBundleIconFile, so the Dock would draw this PNG instead of
        // the bundle's AppIcon.icns and any icon work done at bundle level is discarded.
        if Bundle.main.bundleIdentifier == nil, let icon = Res.image("AppIcon") {
            NSApplication.shared.applicationIconImage = icon
        }
        // `Vole --section=settings` for demos/screenshots; also the key the menu-bar
        // panel's "Settings" item writes to switch the open window's pane.
        if let a = CommandLine.arguments.first(where: { $0.hasPrefix("--section=") }) {
            UserDefaults.standard.set(String(a.dropFirst(10)).capitalized, forKey: "vole.section")
        }
        // Menu-bar utility: no Dock icon until the dashboard window is opened.
        NSApplication.shared.setActivationPolicy(Self.openDashboardAtLaunch ? .regular : .accessory)
    }

    var body: some Scene {
        MenuBarExtra {
            MenuPanel(store: store).frame(width: 324).preferredColorScheme(scheme)
        } label: {
            MenuBarLabel(store: store)
        }
        .menuBarExtraStyle(.window)

        Window("Vole", id: "dashboard") {
            DashboardView(store: store, updateChecker: updateChecker).preferredColorScheme(scheme)
        }
        .defaultLaunchBehavior(Self.openDashboardAtLaunch ? .presented : .suppressed)
        .windowResizability(.contentMinSize)
    }
}

/// Owns the embedded collector's lifecycle — started once AppKit has actually finished
/// launching (not from VoleApp.init, which also runs for the `--dump` headless check
/// and exits before this would ever fire), stopped on a normal quit.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let collector = Collector()

    func applicationDidFinishLaunching(_ notification: Notification) {
        collector.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        collector.stop()
    }
}

/// The menu-bar item: the Vole mark + live 24h token count. The mark is always
/// shown; an active incident tints it (red critical / orange warn).
struct MenuBarLabel: View {
    let store: Store
    @AppStorage("vole.menubar") private var menubar = "tokens"

    /// Bundled bare mark, template so AppKit tracks the menu bar's light/dark.
    /// Sized PROPORTIONALLY: a wide wordmark forced into a square is a 40%
    /// horizontal squash — the distortion that read as "flipped to the top side".
    private static let mark: NSImage? = {
        guard let i = Res.image("MenuBarGlyph") else { return nil }
        i.isTemplate = true
        let px = i.representations.first
        let aspect = (px?.pixelsWide ?? 1) > 0 && (px?.pixelsHigh ?? 0) > 0
            ? Double(px!.pixelsWide) / Double(px!.pixelsHigh)
            : 1
        i.size = NSSize(width: 13 * aspect, height: 13)
        return i
    }()
    /// The live glyph height, surfaced so "is this the new build?" is checkable
    /// by hovering — one point of doubt fewer.
    static let glyphHeight: CGFloat = 13

    var body: some View {
        let sev = store.liveSeverity
        let state = menuBarState
        Group {
            if let mark = Self.mark {
                Image(nsImage: mark)
                    .help("Vole · mark \(Int(Self.glyphHeight))pt")
            } else {
                Image(systemName: "shippingbox.fill")   // asset missing — shouldn't happen
            }
        }
        .foregroundStyle(sev == "critical" ? Color.red
                         : sev == "warn" ? Color.orange : Color.primary)
        if menubar != "icon" {
            // In a degraded state the figure is not the story — the state is.
            Text(state.showsFigure
                 ? (menubar == "cost"
                    ? (store.summary.cost != nil ? Fmt.money(store.summary.cost) : "—")
                    : menubar == "speed"
                      ? (store.tokenSpeed.map { "\(Fmt.compactDbl($0.perMin))/m" } ?? "—")
                      : (store.summary.tokens > 0 ? Fmt.compact(store.summary.tokens) : "—"))
                 : state.badge)
                .foregroundStyle(state.tint)
                .help(state.label)
                .monospacedDigit()
        }
    }

    /// The six honest menu-bar states (#41): what the glyph+tint actually mean,
    /// so "Setting up…" is never shown to a machine that merely has no Claude.
    struct MenuState {
        let label: String
        let badge: String
        let showsFigure: Bool
        let tint: Color
    }
    private var menuBarState: MenuState {
        switch store.collectorStatus {
        case .noData:
            return MenuState(label: "No data yet — the collector has not produced a database", badge: "…", showsFigure: false, tint: .secondary)
        case .stale:
            return MenuState(label: "Collector may have stopped — data is stale", badge: "stale", showsFigure: false, tint: .orange)
        case .live:
            if store.fullDiskAccess == false {
                return MenuState(label: "Collection limited: Full Disk Access is not granted — sources behind TCC read as absent", badge: "limited", showsFigure: true, tint: .orange)
            }
            switch store.liveSeverity {
            case "critical": return MenuState(label: "Critical incident active in the last hour", badge: "", showsFigure: true, tint: .red)
            case "warn": return MenuState(label: "Warning active in the last hour", badge: "", showsFigure: true, tint: .orange)
            case "info": return MenuState(label: "Info-level incidents in the last hour", badge: "", showsFigure: true, tint: .primary)
            default: return MenuState(label: "Live — collector healthy, nothing active", badge: "", showsFigure: true, tint: .primary)
            }
        }
    }
}
