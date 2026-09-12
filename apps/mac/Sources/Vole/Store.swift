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
            Task { await refreshRangeScoped() }
        }
    }

    private(set) var summary: Summary = .empty
    private(set) var series: [TimePoint] = []
    private(set) var incidents: [Incident] = []      // range-scoped (drives the timeline)
    private(set) var allIncidents: [Incident] = []   // every stored incident (Incidents feed)
    private(set) var breakdown: [BreakdownRow] = []
    /// Nil on a store older than yield tracking — distinct from "nothing classified".
    private(set) var yieldSummary: YieldSummary?
    private(set) var findings: [FindingRow] = []
    private(set) var collectorLastSeen: Int?   // epoch-ms of the collector's last scan
    private(set) var heartbeats: [CollectorHeartbeat] = []  // per-collector, latest pass
    /// The live token burn rate (5-min trailing) and the 24h peak minute.
    private(set) var tokenSpeed: TokenSpeed?
    /// The store's schema version, and whether it was written by a Vole newer than
    /// this app — in which case every figure on every screen is suspect and the
    /// version gate banner is the only honest thing to show.
    private(set) var storeSchemaVersion = 0
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
    private var refreshing = false   // drop a poll if the previous one is still running
    /// Queries run off-main now, so results can come back out of order: a slow full
    /// poll started under "24h" must not repaint over a range switch to "7d" that
    /// landed while it was in flight. Every refresh takes a token and only publishes
    /// if it is still the newest one.
    private var generation = 0

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
        dbOK = false          // the first refresh reports the real state
        dbPath = db.path      // nonisolated on the actor
        Task { await refresh() }
        startTimer()
    }

    private func startTimer() {
        timer?.invalidate()
        // .common mode so the poll keeps firing while a menu is open or the window
        // is being resized/scrolled — .default alone stalls in those tracking loops.
        let t = Timer(timeInterval: Double(refreshSeconds), repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    /// Called from Settings when the interval changes.
    func setRefresh(_ seconds: Int) {
        guard seconds != refreshSeconds else { return }
        refreshSeconds = seconds
        UserDefaults.standard.set(seconds, forKey: RefreshInterval.key)
        Task { await refresh() }   // reflect the change immediately
        startTimer()
    }

    /// Re-runs only the range-scoped aggregates. Picking a new range must not
    /// re-run all of refresh()'s queries — several of them don't take `range`
    /// at all, and redoing them on every filter click was what made switching
    /// ranges feel sluggish.
    private func refreshRangeScoped() async {
        generation += 1
        let token = generation
        let r = range
        let s = await db.summary(r)
        let ser = await db.timeseries(r)
        let inc = await db.anomalies(r)
        let bd = await db.breakdown(r)
        let y = await db.yieldSummary(r)
        let f = await db.findings()
        guard token == generation, r == range else { return }
        summary = s; series = ser; incidents = inc; breakdown = bd
        yieldSummary = y; findings = f
    }

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        // A brand-new install has no database yet at launch — the embedded collector
        // needs real startup time to create it. Retry every poll rather than trusting
        // the one-time open in DB.init(), which a fresh machine reliably loses the
        // race against.
        await db.tryOpen()          // no-op once it is open
        let ok = await db.opened
        dbOK = ok
        guard ok else { return }
        generation += 1
        let token = generation
        let r = range
        // Measured on a real 50 MB store, release build: ~18ms at 24h, ~80ms at "all".
        // All of it used to run on the main actor every `refreshSeconds`, which cost
        // ~5 dropped frames per poll at "all". DB is an actor now, so the sqlite work
        // happens off-main and only the assignments below are back on main.
        let prev = (summary.calls, summary.tokens, incidents.count)
        let s = await db.summary(r)
        let ser = await db.timeseries(r)
        let inc = await db.anomalies(r)
        let allInc = await db.anomalies(.all, limit: 500)
        let bd = await db.breakdown(r)
        let lastSeen = await db.collectorLastSeen()
        let schema = await db.schemaVersion()
        let tables = await db.tableNames()
        let speed = await db.tokenSpeed()
        let beats = await db.collectorHeartbeats()
        let y = await db.yieldSummary(r)
        let f = await db.findings()
        guard token == generation, r == range else { return }
        summary = s
        series = ser
        incidents = inc
        allIncidents = allInc
        breakdown = bd
        collectorLastSeen = lastSeen
        storeSchemaVersion = schema
        availableTables = tables
        tokenSpeed = speed
        heartbeats = beats
        yieldSummary = y
        findings = f
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
        // The oldest incident deliberately HELD for quiet hours. The watermark must
        // not pass it, or the hold becomes a permanent drop: this used to advance in
        // a `defer` that also ran on `continue`, so every warn between 22:00 and
        // 07:00 was silently destroyed rather than announced when the window ended.
        var heldFloor: Double?
        var pending: [(Incident, Bool)] = []   // (incident, escalated)
        for incident in allIncidents.sorted(by: { $0.detectedAt < $1.detectedAt }) {
            let stamp = Double(incident.detectedAt)
            // Not a candidate and never will be again — seeded, info-level, aged out
            // of the freshness window, or already behind the watermark. Freshness only
            // decays, so letting the watermark pass these is safe.
            guard incident.source == "live", incident.severity != "info",
                  incident.windowEnd >= cutoff,
                  stamp > lastNotifiedDetectedAt
            else { newMax = max(newMax, stamp); continue }
            // Already announced at this severity or higher.
            if let seen = notifiedSeverity[incident.anomalyKey],
               (rank[seen] ?? 0) >= (rank[incident.severity] ?? 0) {
                newMax = max(newMax, stamp)
                continue
            }
            let escalated = notifiedSeverity[incident.anomalyKey] != nil
            // HELD, not dropped: record nothing, so the next poll re-examines it and
            // it goes out once quiet hours end.
            if inQuietHours && incident.severity != "critical" {
                heldFloor = min(heldFloor ?? stamp, stamp)
                continue
            }
            pending.append((incident, escalated))
            // Only what is actually announced enters the dedupe map. Recording every
            // row here (the old behaviour) both mislabelled later escalations and
            // rewrote the whole dictionary to UserDefaults ~500 times per poll.
            notifiedSeverity[incident.anomalyKey] = incident.severity
            newMax = max(newMax, stamp)
        }
        // A critical announced during quiet hours may have pushed the watermark past a
        // held warning; pull it back. Re-examined incidents are deduped by
        // notifiedSeverity, so nothing announced goes out twice.
        if let floor = heldFloor { newMax = min(newMax, floor - 1) }

        // Bound the dedupe map. It is keyed by anomaly_key and was never pruned, so it
        // grew without limit in UserDefaults — one entry for every incident ever
        // announced, reloaded and rewritten on every launch. Keys the store no longer
        // reports cannot recur inside the 15-minute freshness window, so dropping them
        // cannot cause a re-notification.
        let liveKeys = Set(allIncidents.map(\.anomalyKey))
        if notifiedSeverity.count > liveKeys.count {
            notifiedSeverity = notifiedSeverity.filter { liveKeys.contains($0.key) }
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
