import SwiftUI
import AppKit
import UserNotifications

@main
struct VoleApp: App {
    @State private var store = Store()
    @AppStorage("vole.theme") private var theme = "system"
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    private static let openDashboardAtLaunch = CommandLine.arguments.contains("--dashboard")

    private var scheme: ColorScheme? {
        switch theme { case "light": return .light; case "dark": return .dark; default: return nil }
    }

    init() {
        // Needed once for incident notifications to actually show up.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
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
        // Dock / ⌘-Tab / About icon — needed for `swift run` (an unbundled binary has
        // no CFBundleIconFile); the .app bundle also carries it as AppIcon.icns.
        if let u = Bundle.module.url(forResource: "AppIcon", withExtension: "png"),
           let icon = NSImage(contentsOf: u) {
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
            DashboardView(store: store).preferredColorScheme(scheme)
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
    private static let mark: NSImage? = {
        guard let u = Bundle.module.url(forResource: "MenuBarGlyph", withExtension: "png"),
              let i = NSImage(contentsOf: u) else { return nil }
        i.isTemplate = true
        i.size = NSSize(width: 18, height: 18)
        return i
    }()

    var body: some View {
        let sev = store.liveSeverity
        Group {
            if let mark = Self.mark {
                Image(nsImage: mark)
            } else {
                Image(systemName: "shippingbox.fill")   // asset missing — shouldn't happen
            }
        }
        .foregroundStyle(sev == "critical" ? Color.red
                         : sev == "warn" ? Color.orange : Color.primary)
        switch menubar {
        case "cost":
            Text(store.summary.cost != nil ? Fmt.money(store.summary.cost) : "—")
        case "icon":
            EmptyView()
        default:
            Text(store.summary.tokens > 0 ? Fmt.compact(store.summary.tokens) : "—")
        }
    }
}
