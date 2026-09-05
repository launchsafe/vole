import SwiftUI
import Observation
import UserNotifications

/// How often the app re-reads the collector database. "Live" matches the collector's
/// own 5s write cadence; the longer options are for leaving it open in the background.
enum RefreshInterval: Int, CaseIterable, Identifiable {
    case live = 5, m5 = 300, m10 = 600, m30 = 1800, h1 = 3600
    var id: Int { rawValue }
    var label: String {
        switch self {
        case .live: return "Live"
        case .m5:   return "5 min"
        case .m10:  return "10 min"
        case .m30:  return "30 min"
        case .h1:   return "1 hr"
        }
    }
    static let key = "vole.refresh"
    static var saved: Int { UserDefaults.standard.object(forKey: key) as? Int ?? RefreshInterval.live.rawValue }
}

/// Single source of truth. Re-reads the SQLite database on the chosen interval.
@MainActor
@Observable
final class Store {
    var range: DateRange = {
        // `Vole --range=7d|30d|all` for demos/screenshots.
        if let a = CommandLine.arguments.first(where: { $0.hasPrefix("--range=") }),
           let r = DateRange(rawValue: String(a.dropFirst(8))) { return r }
        // Otherwise remember the last-picked range, so a wider view (where no-token
        // tools like Devin have activity) survives a relaunch.
        if let s = UserDefaults.standard.string(forKey: "vole.range"),
           let r = DateRange(rawValue: s) { return r }
        return .h24
    }() {
        didSet {
            guard oldValue != range else { return }
            UserDefaults.standard.set(range.rawValue, forKey: "vole.range")
            refresh()
        }
    }

    private(set) var summary: Summary = .empty
    private(set) var series: [TimePoint] = []
    private(set) var incidents: [Incident] = []      // range-scoped (drives the timeline)
    private(set) var allIncidents: [Incident] = []   // every stored incident (Incidents feed)
    private(set) var breakdown: [BreakdownRow] = []
    private(set) var collectorLastSeen: Int?   // epoch-ms of the collector's last scan
    private(set) var refreshSeconds: Int = RefreshInterval.saved

    let dbPath: String
    private(set) var dbOK: Bool

    /// The command that starts the collector — surfaced in the "no data" state.
    let collectCommand = "pnpm collect"

    private let db = DB()
    private var timer: Timer?
    private var refreshing = false   // one sqlite connection; don't let callers overlap

    /// High-water mark for incident notifications, persisted so a relaunch doesn't
    /// re-notify. Starts at 0, but `notifyFreshIncidents` still filters to the last
    /// 15 minutes, so a first run against months of history stays silent.
    private var lastNotifiedIncidentID = UserDefaults.standard.integer(forKey: "vole.lastNotifiedIncidentID") {
        didSet { UserDefaults.standard.set(lastNotifiedIncidentID, forKey: "vole.lastNotifiedIncidentID") }
    }

    init() {
        dbOK = db.opened
        dbPath = db.path
        refresh()
        startTimer()
    }

    private func startTimer() {
        timer?.invalidate()
        // .common mode so the poll keeps firing while a menu is open or the window
        // is being resized/scrolled — .default alone stalls in those tracking loops.
        let t = Timer(timeInterval: Double(refreshSeconds), repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    /// Called from Settings when the interval changes.
    func setRefresh(_ seconds: Int) {
        guard seconds != refreshSeconds else { return }
        refreshSeconds = seconds
        UserDefaults.standard.set(seconds, forKey: RefreshInterval.key)
        refresh()          // reflect the change immediately
        startTimer()
    }

    func refresh() {
        // A brand-new install has no database yet at launch — the embedded collector
        // needs real startup time to create it. Retry every poll rather than trusting
        // the one-time open in DB.init(), which a fresh machine reliably loses the
        // race against.
        if !db.opened { db.tryOpen() }
        dbOK = db.opened
        guard db.opened, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        // ~10ms on main in release on a 10 MB db, every `refreshSeconds`. `summary()`
        // (3 aggregates) is most of it; the collector schema carries an (source, ts)
        // index for these. Move off-main only if it ever shows up as a hitch.
        let prev = (summary.calls, summary.tokens, incidents.count)
        summary = db.summary(range)
        series = db.timeseries(range)
        incidents = db.anomalies(range)
        allIncidents = db.anomalies(.all, limit: 500)
        breakdown = db.breakdown(range)
        collectorLastSeen = db.collectorLastSeen()
        notifyFreshIncidents()
        #if DEBUG
        if prev != (summary.calls, summary.tokens, incidents.count) {
            FileHandle.standardError.write(Data(
                "[poll] \(Date()) calls=\(summary.calls) tokens=\(summary.tokens) incidents=\(incidents.count)\n".utf8))
        }
        #endif
    }

    /// Whether Vole is actually receiving data — separates "quiet" from "collector down".
    enum CollectorStatus: Equatable {
        case noData               // no database, or the collector has never run
        case stale(since: Date)   // it ran, but not recently — probably stopped
        case live
    }

    var collectorStatus: CollectorStatus {
        guard dbOK, let ms = collectorLastSeen else { return .noData }
        let seen = Date(timeIntervalSince1970: Double(ms) / 1000)
        // The collector polls every few seconds; allow that plus our own re-read gap.
        if Date.now.timeIntervalSince(seen) > Double(refreshSeconds) * 2 + 20 {
            return .stale(since: seen)
        }
        return .live
    }

    /// Posts a local notification for each new warn/critical incident that's still fresh
    /// (mirrors the collector's own 15-minute freshness window). Posted from the app so
    /// Notification Center shows the Vole icon — `osascript` always shows Script Editor's.
    private func notifyFreshIncidents() {
        // UNUserNotificationCenter throws for a process with no bundle identifier — true
        // of a bare `swift run` binary, never true of a real .app. Skip there rather than
        // crash; the developer running unbundled has no Notification Center identity to
        // post to anyway.
        guard Bundle.main.bundleIdentifier != nil else { return }
        let cutoff = Int(Date.now.timeIntervalSince1970 * 1000) - 15 * 60_000
        let fresh = allIncidents.filter {
            $0.id > lastNotifiedIncidentID && $0.source == "live" && $0.severity != "info" && $0.windowEnd >= cutoff
        }
        for incident in fresh.sorted(by: { $0.id < $1.id }) {
            let content = UNMutableNotificationContent()
            content.title = "Vole · \(incident.severity.uppercased())"
            content.body = incident.title
            content.sound = .default
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "vole-incident-\(incident.id)", content: content, trigger: nil))
        }
        if let maxID = allIncidents.map(\.id).max(), maxID > lastNotifiedIncidentID {
            lastNotifiedIncidentID = maxID
        }
    }

    /// Worst severity among incidents whose window touches the last hour — drives the
    /// menu-bar icon.
    var liveSeverity: String? {
        let cutoff = Int(Date.now.timeIntervalSince1970 * 1000) - 3_600_000
        let active = incidents.filter { $0.windowEnd >= cutoff }
        if active.contains(where: { $0.severity == "critical" }) { return "critical" }
        if active.contains(where: { $0.severity == "warn" }) { return "warn" }
        return active.isEmpty ? nil : "info"
    }
}
