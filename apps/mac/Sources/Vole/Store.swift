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
    private(set) var heartbeats: [CollectorHeartbeat] = []  // per-collector, latest pass
    private(set) var aiSurfaces: [AiSurface] = []
    private(set) var findingActions: [FindingAction] = []
    private(set) var secretSightings: [SecretSighting] = []
    private(set) var scanStates: [ScanStateRow] = []
    /// The live token burn rate (5-min trailing) and the 24h peak minute.
    private(set) var tokenSpeed: TokenSpeed?
    /// Generation speed per model (tok/s), with coverage.
    private(set) var modelSpeeds: [ModelSpeed] = []
    /// The Tier 5 tool-call ledger (recent window).
    private(set) var toolCalls: [ToolCallEntry] = []
    /// Blast Radius destinations from command shapes.
    private(set) var blastRadius: [BlastEntry] = []
    /// The subagent tree: session → agent edges.
    private(set) var agentEdges: [AgentEdge] = []
    /// Tier 3: pseudonymous principals + devices.
    private(set) var principals: [PrincipalEntry] = []
    private(set) var devices: [DeviceEntry] = []
    /// Tier 6: permission declarations.
    private(set) var grants: [GrantEntry] = []
    /// The DLP denominator, in bytes: what the engine has actually read.
    var scanDenominator: Int { scanStates.reduce(0) { $0 + $1.bytesScanned } }
    private(set) var fieldDictionary: [(table: String, columns: [(name: String, type: String)])] = []
    /// The store's schema version, and whether it was written by a Vole newer than
    /// this app — in which case every figure on every screen is suspect and the
    /// version gate banner is the only honest thing to show.
    private(set) var storeSchemaVersion = 0
    /// The migration ledger — the upgrade boundary made visible: a step with an
    /// unknown date predates the ledger, and everything before it must read
    /// "not recorded", never zero.
    private(set) var migrationLedger: [MigrationRow] = []
    /// Every table and view the store actually has — the capability set the
    /// navigation shell probes against, refreshed on the existing poll.
    private(set) var availableTables: Set<String> = []
    var storeIsFromTheFuture: Bool { storeSchemaVersion > DB.knownSchemaVersion }
    private(set) var refreshSeconds: Int = RefreshInterval.saved

    let dbPath: String
    private(set) var dbOK: Bool

    /// The command that starts the collector — surfaced in the "no data" state.
    let collectCommand = "pnpm collect"

    private let db = DB()
    private var timer: Timer?
    private var refreshing = false   // one sqlite connection; don't let callers overlap

    /// Notification watermark, persisted so a relaunch doesn't re-notify.
    ///
    /// Two parts, because escalations UPDATE rows in place: `lastNotifiedDetectedAt`
    /// is the MAX(detected_at) already notified (detected_at advances when the
    /// collector escalates a stored anomaly, so an UPDATE reaches this gate), and
    /// `notifiedSeverity` records the severity last notified per anomaly_key, so a
    /// window that merely GREW — detected_at moved, severity did not — is seen,
    /// compared, and deliberately not re-notified. The old MAX(id) watermark could
    /// never see an update at all.
    private var lastNotifiedDetectedAt = UserDefaults.standard.double(forKey: "vole.lastNotifiedDetectedAt") {
        didSet { UserDefaults.standard.set(lastNotifiedDetectedAt, forKey: "vole.lastNotifiedDetectedAt") }
    }
    private var notifiedSeverity: [String: String] =
        UserDefaults.standard.dictionary(forKey: "vole.notifiedSeverity") as? [String: String] ?? [:] {
        didSet { UserDefaults.standard.set(notifiedSeverity, forKey: "vole.notifiedSeverity") }
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
        storeSchemaVersion = db.schemaVersion()
        migrationLedger = db.migrationLedger()
        availableTables = db.tableNames()
        aiSurfaces = db.aiSurfaces()
        findingActions = db.findingActions()
        secretSightings = db.secretSightings()
        scanStates = db.scanStates()
        tokenSpeed = db.tokenSpeed()
        modelSpeeds = db.modelSpeeds(range)
        toolCalls = db.toolCalls()
        blastRadius = db.blastRadius()
        agentEdges = db.agentEdges()
        principals = db.principals()
        devices = db.devices()
        grants = db.grants()
        fieldDictionary = db.fieldDictionary()
        let beats = db.collectorHeartbeats()
        heartbeats = beats
        // With per-collector heartbeats, liveness is "any collector completed a pass
        // recently" — not "Claude Code touched a file", which left every non-Claude
        // Mac reading as never-set-up while rows accumulated behind the gate.
        if let newest = beats.map(\.startedAt).max(), (collectorLastSeen ?? 0) < newest {
            collectorLastSeen = newest
        }
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
    /// (mirrors the collector's own 15-minute freshness window), and for each ESCALATION:
    /// a stored anomaly whose severity rose after it was already notified — a window first
    /// seen at warn that ends critical must re-notify, a window that merely grew must not.
    /// Posted from the app so Notification Center shows the Vole icon — `osascript` always
    /// shows Script Editor's.
    ///
    /// Coalescing (#44): incidents are batched per poll — one notification per RULE,
    /// capped, with "+N more" in the body — and quiet hours (22:00–07:00 by default)
    /// hold everything except criticals. One bad agent minute must not page a user
    /// forty times.
    private func notifyFreshIncidents() {
        // UNUserNotificationCenter throws for a process with no bundle identifier — true
        // of a bare `swift run` binary, never true of a real .app. Skip there rather than
        // crash; the developer running unbundled has no Notification Center identity to
        // post to anyway.
        guard Bundle.main.bundleIdentifier != nil else { return }
        let cutoff = Int(Date.now.timeIntervalSince1970 * 1000) - 15 * 60_000
        let rank: [String: Int] = ["info": 0, "warn": 1, "critical": 2]

        // Quiet hours: 22:00–07:00 unless disabled; criticals always pass.
        let hour = Calendar.current.component(.hour, from: Date())
        let quietHours = UserDefaults.standard.object(forKey: "vole.quietHours") as? Bool ?? true
        let inQuietHours = quietHours && (hour >= 22 || hour < 7)

        var newMax = lastNotifiedDetectedAt
        var pending: [(Incident, Bool)] = []   // (incident, escalated)
        for incident in allIncidents.sorted(by: { $0.detectedAt < $1.detectedAt }) {
            defer {
                newMax = max(newMax, Double(incident.detectedAt))
                notifiedSeverity[incident.anomalyKey] = incident.severity
            }
            guard incident.source == "live", incident.severity != "info",
                  incident.windowEnd >= cutoff,
                  Double(incident.detectedAt) > lastNotifiedDetectedAt
            else { continue }
            if let seen = notifiedSeverity[incident.anomalyKey],
               (rank[seen] ?? 0) >= (rank[incident.severity] ?? 0) { continue }
            let escalated = notifiedSeverity[incident.anomalyKey] != nil
            if inQuietHours && incident.severity != "critical" { continue }
            pending.append((incident, escalated))
        }

        // Coalesce: one notification per rule, newest first, with counts.
        var byRule: [String: [(Incident, Bool)]] = [:]
        for p in pending { byRule[p.0.rule, default: []].append(p) }
        for (rule, items) in byRule.sorted(by: { $0.value.count > $1.value.count }) {
            let first = items.first!.0
            let content = UNMutableNotificationContent()
            content.title = "Vole · \(first.severity.uppercased())\(items.first!.1 ? " (escalated)" : "")"
            content.body = items.count == 1
                ? first.title
                : "\(first.title) — and \(items.count - 1) more \(Labels.ruleLabel(rule))"
            content.sound = .default
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "vole-incident-\(first.id)", content: content, trigger: nil))
        }
        lastNotifiedDetectedAt = newMax
    }

    /// Whether the collector can read everything it was built to read — the FDA
    /// canary's verdict, from the census. nil when the canary has not run yet.
    var fullDiskAccess: Bool? {
        aiSurfaces.first { $0.surfaceKey == "launch-context:fda" }.map { surface in
            !(surface.evidence ?? "").contains("CANNOT")
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
