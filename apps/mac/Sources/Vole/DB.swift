import Foundation
import SQLite3

// MARK: - Models  (mirror packages/core/src/queries.ts)

enum DateRange: String, CaseIterable, Identifiable {
    case h24 = "24h", d7 = "7d", d30 = "30d", all = "all"
    var id: String { rawValue }

    func startMs(now: Date = .now) -> Int {
        let ms = Int(now.timeIntervalSince1970 * 1000)
        switch self {
        case .h24: return ms - 24 * 3_600_000
        case .d7:  return ms - 7 * 24 * 3_600_000
        case .d30: return ms - 30 * 24 * 3_600_000
        case .all: return 0
        }
    }
    /// Hourly detail for a day, daily buckets for anything longer — same as queries.ts.
    var bucketMs: Int { self == .h24 ? 3_600_000 : 24 * 3_600_000 }
}

struct ToolSummary: Identifiable {
    let tool: String
    let calls: Int
    let tokens: Int?          // nil when every row for this tool is activity_only
    let cost: Double?
    let confidence: String
    /// Calls in this group that recorded no tokens — a mixed group renders as mixed.
    let activityOnlyCalls: Int
    var id: String { tool }
}

struct Summary {
    var calls = 0
    var tokens = 0
    var cost: Double? = nil
    var sessions = 0
    var errors = 0
    /// Calls that stopped because they hit the output-token limit. Was computed by
    /// the TS reader for months and absent here — the exact drift the parity check exists to catch.
    var truncated = 0
    var cacheHitRatio: Double? = nil
    var hasActivityOnly = false
    var hasSeed = false
    var byTool: [ToolSummary] = []
    static let empty = Summary()
}

struct TimePoint: Identifiable {
    let bucket: Int                       // epoch ms, bucket start
    var tokensByTool: [String: Int]
    var id: Int { bucket }
    var total: Int { tokensByTool.values.reduce(0, +) }
    var date: Date { Date(timeIntervalSince1970: Double(bucket) / 1000) }
}

/// One ledgered schema step, for the Settings boundary display.
struct MigrationRow: Identifiable {
    let version: Int
    let name: String
    /// nil = applied before the ledger existed; renders as 'unknown', never a date.
    let appliedAt: Int?
    var id: Int { version }
}

/// One AI surface from the Shadow AI registry — inventory, never usage.
struct AiSurface: Identifiable {
    let surfaceKey: String
    let kind: String        // app | gateway | cli
    let name: String
    let path: String?
    let evidence: String?
    let version: String?
    let firstSeen: Int
    let lastSeen: Int
    /// nil = no policy loaded at the last scan ("unknown", never "false");
    /// true/false = the admin declaration's verdict, re-evaluated every scan.
    let sanctioned: Bool?
    var id: String { surfaceKey }
}

/// Token speed figures — the trailing burn rate, not an instant.
struct ToolSpeed: Identifiable {
    let tool: String
    let perMin: Double
    var id: String { tool }
}
struct TokenSpeed {
    let perMin: Double
    let peakPerMin: Double
    let byTool: [ToolSpeed]
}

/// One tool invocation from the Tier 5 ledger.
struct ToolCallEntry: Identifiable {
    let tool: String
    let name: String
    let shape: String?
    let sessionID: String?
    let agentID: String?
    let ts: Int
    let status: String?
    let statusSource: String?
    let durationMs: Int?
    let durationKind: String?
    let authority: String?
    var id: String { "\(tool):\(name):\(ts)" }
}

/// A pseudonymous principal — an HMAC, a label, never a name.
struct PrincipalEntry: Identifiable {
    let principalKey: String
    let display: String
    let firstSeen: Int
    let lastSeen: Int
    var id: String { principalKey }
}

struct DeviceEntry: Identifiable {
    let deviceKey: String
    let hostname: String?
    let firstSeen: Int
    let lastSeen: Int
    var id: String { deviceKey }
}

/// One permission declaration, verbatim from the file that granted it.
struct GrantEntry: Identifiable {
    let grantKey: String
    let agent: String
    let sourceFile: String
    let kind: String
    let entry: String
    let firstSeen: Int
    let lastSeen: Int
    var id: String { grantKey }
}

/// One session/agent edge in the subagent tree.
struct AgentEdge: Identifiable {
    let session: String
    let agent: String
    let calls: Int
    let first: Int
    let last: Int
    let errors: Int
    var id: String { "\(session):\(agent)" }
}

/// One model's measured generation speed, with its coverage.
struct ModelSpeed: Identifiable {
    let tool: String
    let model: String?
    let tokensPerSecond: Double
    let medianDurationMs: Double
    let rows: Int
    let coverage: Double
    let kind: String
    var id: String { "\(tool):\(model ?? "?")" }
}

/// The latest triage disposition per incident.
struct FindingAction: Identifiable {
    let anomalyKey: String
    let action: String      // acknowledged | muted | escalated | reopened
    let note: String?
    let until: Int?
    let createdAt: Int
    var id: String { anomalyKey }
}

/// The latest pass of one collector — the heartbeat a coverage strip renders from.
/// `sourceState` says what the look itself found: "ok", "no_source" (the tool's
/// artifacts do not exist on this machine — absence, never zero usage), "error".
struct CollectorHeartbeat: Identifiable {
    let tool: String
    let startedAt: Int
    let durationMs: Int
    let files: Int
    let parsed: Int
    let inserted: Int
    let sourceState: String
    let ok: Bool
    var id: String { tool }
}

struct Incident: Identifiable {    let id: Int
    let anomalyKey: String
    let rule: String
    let severity: String
    let tool: String
    let sessionID: String?
    let model: String?
    let windowStart: Int
    let windowEnd: Int
    let title: String
    let detail: String
    let observed: Double
    let baseline: Double?
    let threshold: Double?
    let confidence: String
    let source: String
    let detectedAt: Int

    func bucket(_ ms: Int) -> Int { (windowStart / ms) * ms }
}

struct BreakdownRow: Identifiable {
    let tool: String
    let model: String?
    let confidence: String
    let calls: Int
    let tokens: Int?
    let cost: Double?
    let cacheRead: Int?
    let output: Int?
    var id: String { "\(tool)|\(model ?? "-")|\(confidence)" }
    var tokensSort: Int { tokens ?? -1 }
    var costSort: Double { cost ?? -1 }
}

// MARK: - Deep-completion read models (tiers 3-8) — mirror queries.ts
//
// Each surface the tier docs name for this reader: the People view's principal
// dimension, the ungated-call KPI, Blast Radius over the action-target and
// child ledgers, the Files tab's write classes, the ingress band, the posture
// ribbon, server-tool billing, observation lag and the Grok bulk-egress card.
// Every figure is verbatim from its ledger; nil means unknown, never 0.

/// The People view's principal dimension (port of getByPrincipal).
struct PrincipalSummaryRow: Identifiable {
    let principalKey: String
    let display: String
    let sessions: Int
    let calls: Int
    /// nil = no exact rows for this principal — unknown, never zero.
    let tokens: Int?
    let costUsd: Double?
    let info: Int, warn: Int, critical: Int
    /// binding triple + sessions with no identity row at all.
    let sessionProved: Int, ambient: Int, unbound: Int, noIdentityRow: Int
    let accountClasses: [(tool: String?, accountClass: String?, sessions: Int)]
    var id: String { principalKey }
}

/// The ungated-call KPI: calls that ran with no gate at all.
struct UngatedCallCounts {
    let calls: Int
    let totalCalls: Int
}

/// Blast Radius over action_targets, joined to the child ledgers' scope reach.
struct BlastTargetRow: Identifiable {
    let targetKind: String
    let targetLabel: String?
    let locality: String?
    let envClass: String?
    let calls: Int
    /// child-ledger corroboration: counts in the same window, not per-target.
    var writes: Int = 0
    var vcsActions: Int = 0
    var packageExecs: Int = 0
    var id: String { "\(targetKind)|\(targetLabel ?? "-")|\(locality ?? "-")|\(envClass ?? "-")" }
}

/// The Files tab: writes split by write_class; unresolved paths counted, never dropped.
struct WriteClassRow: Identifiable {
    let writeClass: String
    let writes: Int
    var unresolved: Int = 0
    var id: String { writeClass }
}

/// The ingress band: fetch ingress by host, NULL status counted as unknown.
struct IngressHostRow: Identifiable {
    let urlHost: String?
    let calls: Int
    /// nil = the row never stated a size.
    let bytes: Int?
    let statusUnknown: Int
    var id: String { urlHost ?? "?" }
}

/// One autonomy interval — a segment of the posture ribbon.
struct AutonomyInterval: Identifiable {
    let sessionID: String
    let autonomy: String?
    let startedAt: Int
    let endedAt: Int
    let calls: Int
    let denied: Int
    let errors: Int
    let modeRaw: String?
    var id: String { "\(sessionID):\(startedAt)" }
}

/// Server-tool billing: the request counters the vendors bill on.
struct ServerToolRow: Identifiable {
    let linkKind: String
    let requests: Int
    var id: String { linkKind }
}

/// Observation lag per tool: observed_at minus ts. Double, not Int — some
/// sources carry fractional-millisecond timestamps, and the reader must not
/// truncate what queries.ts prints in full (read-model parity).
struct LagRow: Identifiable {
    let tool: String
    let p50Ms: Double?
    let p95Ms: Double?
    let observedRows: Int
    var id: String { tool }
}

/// A Grok repo_state upload, with its decision chain (nil size = never enqueued).
struct BulkEgressEntry: Identifiable {
    let uploadKey: String
    let repoPath: String?
    let turn: Int?
    let maxFileBytes: Int?
    let sizeBytes: Int?
    let gcsPath: String?
    let blobs: Int?
    let uploadsEnabled: Int?
    let uploadReason: String?
    let telemetrySource: String?
    var id: String { uploadKey }
}

/// The MCP dimension: servers grouped by identity, observed-only split.
struct McpServerRow: Identifiable {
    let serverName: String
    let mcpIdentity: String
    let clients: Int
    let transport: String?
    /// nil = no enabled state observed.
    let enabled: Int?
    var id: String { "\(serverName):\(mcpIdentity)" }
}

/// A raw column value, typed as SQLite stored it — the parity dump prints it
/// exactly as the TS reader would (integer unquoted, text quoted, null as null).
enum RawVal {
    case null
    case int(Int)
    case text(String)
    var json: String {
        switch self {
        case .null: return "null"
        case .int(let n): return String(n)
        case .text(let s): return "\"\(jstr(s))\""
        }
    }
}

/// The ai_surfaces read model (port of getAiSurfaces) — ordered by surface_key,
/// sanctioned verbatim, never interpreted here.
struct AiSurfaceRow: Identifiable {
    let surfaceKey: String
    let kind: String
    let name: String
    let path: String?
    let sanctioned: RawVal
    let version: String?
    let firstSeen: Int
    let lastSeen: Int
    var id: String { surfaceKey }
}

// MARK: - Column helpers

private func colInt(_ s: OpaquePointer, _ i: Int32) -> Int { Int(sqlite3_column_int64(s, i)) }
private func colIntOpt(_ s: OpaquePointer, _ i: Int32) -> Int? {
    sqlite3_column_type(s, i) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(s, i))
}
private func colDblOpt(_ s: OpaquePointer, _ i: Int32) -> Double? {
    sqlite3_column_type(s, i) == SQLITE_NULL ? nil : sqlite3_column_double(s, i)
}
private func colText(_ s: OpaquePointer, _ i: Int32) -> String? {
    guard let c = sqlite3_column_text(s, i) else { return nil }
    return String(cString: c)
}
/// A column read as whatever type SQLite actually stored — the twin of
/// better-sqlite3's dynamic typing, so the parity dump prints the same shape.
private func colRaw(_ s: OpaquePointer, _ i: Int32) -> RawVal {
    switch sqlite3_column_type(s, i) {
    case SQLITE_NULL: return .null
    case SQLITE_INTEGER: return .int(Int(sqlite3_column_int64(s, i)))
    case SQLITE_FLOAT: return .text(String(sqlite3_column_double(s, i)))
    default: return colText(s, i).map { .text($0) } ?? .null
    }
}

// JSON helpers for the parity dump: 1e-6 rounding on both sides means the diff
// shows read-model differences, never last-digit float noise between runtimes.
private func jnum(_ x: Double?) -> String {
    guard let x else { return "null" }
    return String(format: "%.6g", (x * 1e6).rounded() / 1e6)
}
private func jstr(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n")
}

// MARK: - Database  (read-only; the TS collector owns writes)

final class DB {
    /// The newest store schema this app understands. Must move in lockstep with the
    /// collector's MIGRATIONS head (packages/core/src/db.ts) — the version gate
    /// depends on the two agreeing about what "current" means. The read-model
    /// parity check asserts this against the fixture store (always at the TS head),
    /// so a forgotten bump fails CI instead of shipping a gate that blocks users.
    static let knownSchemaVersion = 28

    private var handle: OpaquePointer?
    let path: String
    private(set) var opened = false

    /// activity_only rows are counted as calls but excluded from token/cost maths.
    private let tf = "confidence != 'activity_only'"

    init() {
        // `VOLE_DB` points at an alternate database (dev / tests) — parity with the
        // Node collector's own env override.
        if let override = ProcessInfo.processInfo.environment["VOLE_DB"], !override.isEmpty {
            path = override
        } else {
            path = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".vole/vole.db").path
        }

        tryOpen()
    }

    /// A brand-new install has no database file yet at the moment the app launches —
    /// the embedded collector (a separate process, needing real startup time) hasn't
    /// created it. `Store.refresh()` calls this on every poll until it succeeds, so
    /// the app recovers within one poll interval instead of being stuck showing "no
    /// database" for the rest of the session once the file does exist.
    func tryOpen() {
        guard !opened else { return }
        var h: OpaquePointer?
        if sqlite3_open_v2(path, &h, SQLITE_OPEN_READONLY, nil) == SQLITE_OK {
            // WAL cold-open probe: with no live -shm/-wal files (clean collector
            // exit, or any copied store) a READONLY open returns SQLITE_OK but
            // cannot rebuild the WAL index, so every prepare fails with "unable
            // to open database file". One cheap prepare — it runs every launch —
            // tells us whether this connection can actually read.
            var stmt: OpaquePointer?
            let readable = sqlite3_prepare_v2(h, "SELECT 1 FROM sqlite_master LIMIT 1", -1, &stmt, nil) == SQLITE_OK
            if let stmt { sqlite3_finalize(stmt) }
            if readable {
                handle = h; opened = true
                sqlite3_busy_timeout(h, 2000)
                return
            }
            sqlite3_close_v2(h)
            h = nil
        }
        var h2: OpaquePointer?
        if sqlite3_open_v2(path, &h2, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK {
            // ponytail: WAL databases sometimes refuse a pure READONLY connection;
            // the file is user-writable, so fall back rather than show nothing.
            handle = h2; opened = true
            sqlite3_busy_timeout(h2, 2000)
        }
    }

    deinit { if let handle { sqlite3_close_v2(handle) } }

    private func run(_ sql: String, _ binds: [Int] = [], _ row: (OpaquePointer) -> Void) {
        guard let handle else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else {
            if let m = sqlite3_errmsg(handle) { fputs("[db] \(String(cString: m))\n", stderr) }
            return
        }
        defer { sqlite3_finalize(stmt) }
        for (i, v) in binds.enumerated() { sqlite3_bind_int64(stmt, Int32(i + 1), Int64(v)) }
        while sqlite3_step(stmt) == SQLITE_ROW { row(stmt!) }
    }

    /// Typed binds for the read models: without text binds, no drill-down keyed on
    /// session_id, rule or user is expressible at all — the old [Int]-only runner
    /// made every keyed query impossible by construction.
    enum Bind {
        case int(Int)
        case text(String)
        case dbl(Double)
    }

    private func runBound(_ sql: String, _ binds: [Bind], _ row: (OpaquePointer) -> Void) {
        guard let handle else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else {
            if let m = sqlite3_errmsg(handle) { fputs("[db] \(String(cString: m))\n", stderr) }
            return
        }
        defer { sqlite3_finalize(stmt) }
        for (i, b) in binds.enumerated() {
            switch b {
            case .int(let v): sqlite3_bind_int64(stmt, Int32(i + 1), Int64(v))
            case .text(let v): sqlite3_bind_text(stmt, Int32(i + 1), v, -1, SQLITE_TRANSIENT)
            case .dbl(let v): sqlite3_bind_double(stmt, Int32(i + 1), v)
            }
        }
        while sqlite3_step(stmt) == SQLITE_ROW { row(stmt!) }
    }

    /// Capability probe for the navigation shell: a section whose backing table is
    /// absent still appears and says so — never an empty list pretending to be a
    /// finding. Probed once per launch, not per render.
    func hasTable(_ name: String) -> Bool {
        var found = false
        runBound("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?", [.text(name)]) { row in
            found = colInt(row, 0) > 0
        }
        return found
    }

    /// The full capability set, for the nav shell's probe.
    func tableNames() -> Set<String> {
        var out: Set<String> = []
        run("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')") { row in
            if let n = colText(row, 0) { out.insert(n) }
        }
        return out
    }

    /// Every AI surface the census found — the Shadow AI screen's data.
    func aiSurfaces() -> [AiSurface] {
        var out: [AiSurface] = []
        run("""
            SELECT surface_key, kind, name, path, evidence, version, first_seen, last_seen, sanctioned
            FROM ai_surfaces ORDER BY kind, name
            """) { row in
            out.append(AiSurface(
                surfaceKey: colText(row, 0) ?? "?",
                kind: colText(row, 1) ?? "?",
                name: colText(row, 2) ?? "?",
                path: colText(row, 3),
                evidence: colText(row, 4),
                version: colText(row, 5),
                firstSeen: colInt(row, 6),
                lastSeen: colInt(row, 7),
                sanctioned: colIntOpt(row, 8).map { $0 == 1 }))
        }
        return out
    }

    /// The latest triage disposition per incident — muted counts only while its
    /// expiry has not passed.
    func findingActions() -> [FindingAction] {
        var out: [FindingAction] = []
        run("""
            SELECT fa.anomaly_key, fa.action, fa.note, fa.until, fa.created_at
            FROM finding_actions fa
            JOIN (SELECT anomaly_key, MAX(created_at) AS latest
                  FROM finding_actions GROUP BY anomaly_key) latest
              ON latest.anomaly_key = fa.anomaly_key AND latest.latest = fa.created_at
            """) { row in
            out.append(FindingAction(
                anomalyKey: colText(row, 0) ?? "?",
                action: colText(row, 1) ?? "?",
                note: colText(row, 2),
                until: colIntOpt(row, 3),
                createdAt: colInt(row, 4)))
        }
        return out
    }

    /// The store's field dictionary, for the Privacy Center: every table, every
    /// column, its type. What Vole stores is exactly this list — no more.
    func fieldDictionary() -> [(table: String, columns: [(name: String, type: String)])] {
        var tables: [String] = []
        run("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name") { row in
            if let n = colText(row, 0) { tables.append(n) }
        }
        var out: [(String, [(String, String)])] = []
        for t in tables {
            var cols: [(String, String)] = []
            runBound("SELECT name, type FROM pragma_table_info(?)", [.text(t)]) { row in
                if let n = colText(row, 0), let ty = colText(row, 1) { cols.append((n, ty)) }
            }
            out.append((t, cols))
        }
        return out
    }

    // SQLITE_TRANSIENT is not exposed by the SQLite module map — the standard shim.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

// MARK: queries

    func summary(_ r: DateRange) -> Summary {
        let from = r.startMs()
        var s = Summary()
        var cacheRead = 0, freshIn = 0

        run("""
            SELECT COUNT(*),
                   COALESCE(SUM(CASE WHEN \(tf) THEN total_tokens END), 0),
                   SUM(cost_usd),
                   COUNT(DISTINCT session_id),
                   COALESCE(SUM(is_error), 0),
                   COALESCE(SUM(CASE WHEN stop_reason IN ('max_tokens', 'length') THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN \(tf) THEN cache_read_tokens END), 0),
                   COALESCE(SUM(CASE WHEN \(tf) THEN COALESCE(input_tokens,0)
                        + COALESCE(cache_write_5m_tokens,0) + COALESCE(cache_write_1h_tokens,0) END), 0)
            FROM usage_events WHERE ts >= ? AND source = 'live'
            """, [from]) { row in
            s.calls = colInt(row, 0); s.tokens = colInt(row, 1); s.cost = colDblOpt(row, 2)
            s.sessions = colInt(row, 3); s.errors = colInt(row, 4)
            s.truncated = colInt(row, 5)
            cacheRead = colInt(row, 6); freshIn = colInt(row, 7)
        }

        run("""
            SELECT tool, COUNT(*),
                   CASE WHEN SUM(CASE WHEN \(tf) THEN 1 ELSE 0 END) = 0 THEN NULL
                        ELSE COALESCE(SUM(CASE WHEN \(tf) THEN total_tokens END), 0) END,
                   SUM(cost_usd),
                   CASE WHEN SUM(confidence != 'activity_only') = 0
                        THEN 'activity_only' ELSE 'exact' END,
                   SUM(CASE WHEN confidence = 'activity_only' THEN 1 ELSE 0 END)
            FROM usage_events WHERE ts >= ? AND source = 'live'
            GROUP BY tool ORDER BY COUNT(*) DESC
            """, [from]) { row in
            s.byTool.append(ToolSummary(
                tool: colText(row, 0) ?? "?", calls: colInt(row, 1),
                tokens: colIntOpt(row, 2), cost: colDblOpt(row, 3),
                confidence: colText(row, 4) ?? "exact",
                activityOnlyCalls: colInt(row, 5)))
        }

        run("""
            SELECT SUM(CASE WHEN confidence = 'activity_only' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN source = 'seed' THEN 1 ELSE 0 END)
            FROM usage_events WHERE ts >= ?
            """, [from]) { row in
            s.hasActivityOnly = colInt(row, 0) > 0
            s.hasSeed = colInt(row, 1) > 0
        }

        let denom = cacheRead + freshIn
        s.cacheHitRatio = denom > 0 ? Double(cacheRead) / Double(denom) : nil
        return s
    }

    func timeseries(_ r: DateRange) -> [TimePoint] {
        let from = r.startMs(), b = r.bucketMs
        var map: [Int: TimePoint] = [:]
        // CAST is required or a bound numeric param makes SQLite divide in floating point
        // and every event lands in its own bucket.
        run("""
            SELECT CAST(ts / ? AS INTEGER) * ?, tool,
                   COALESCE(SUM(CASE WHEN \(tf) THEN total_tokens END), 0)
            FROM usage_events WHERE ts >= ? AND source = 'live'
            GROUP BY 1, tool ORDER BY 1
            """, [b, b, from]) { row in
            let bucket = colInt(row, 0)
            var pt = map[bucket] ?? TimePoint(bucket: bucket, tokensByTool: [:])
            pt.tokensByTool[colText(row, 1) ?? "?"] = colInt(row, 2)
            map[bucket] = pt
        }
        guard !map.isEmpty else { return [] }
        // Zero-fill (mirrors getTimeseries in queries.ts): a quiet day is a zero
        // bucket, never a missing one — a week-long gap that renders as adjacent
        // bars makes eight active days look like eight equal days.
        let first = map.keys.min()!
        let nowBucket = (Int(Date().timeIntervalSince1970 * 1000) / b) * b
        let last = max(nowBucket, map.keys.max()!)
        var k = first
        while k <= last {
            if map[k] == nil { map[k] = TimePoint(bucket: k, tokensByTool: [:]) }
            k += b
        }
        return map.values.sorted { $0.bucket < $1.bucket }
    }

    func anomalies(_ r: DateRange, limit: Int = 100) -> [Incident] {
        let from = r.startMs()
        var out: [Incident] = []
        // v_incident_explained (migration 7) is the shared read-model view: the
        // shape lives in the store, not in two diverging SQL strings.
        run("""
            SELECT id, anomaly_key, rule, severity, tool, session_id, model, window_start, window_end,
                   title, detail, observed, baseline, threshold, confidence, source, detected_at
            FROM v_incident_explained WHERE window_end >= ? AND source = 'live'
            ORDER BY window_start DESC LIMIT ?
            """, [from, limit]) { row in
            out.append(Incident(
                id: colInt(row, 0), anomalyKey: colText(row, 1) ?? "",
                rule: colText(row, 2) ?? "", severity: colText(row, 3) ?? "info",
                tool: colText(row, 4) ?? "?", sessionID: colText(row, 5), model: colText(row, 6),
                windowStart: colInt(row, 7), windowEnd: colInt(row, 8),
                title: colText(row, 9) ?? "", detail: colText(row, 10) ?? "",
                observed: colDblOpt(row, 11) ?? 0, baseline: colDblOpt(row, 12),
                threshold: colDblOpt(row, 13),
                confidence: colText(row, 14) ?? "exact", source: colText(row, 15) ?? "live",
                detectedAt: colInt(row, 16)))
        }
        return out
    }

    /// The store's own schema version (PRAGMA user_version, written by the
    /// collector's migration ledger). 0 on a pre-ledger store.
    func schemaVersion() -> Int {
        var v = 0
        run("PRAGMA user_version") { v = colInt($0, 0) }
        return v
    }

    /// The DLP scan state — the coverage denominator for exposure figures.
    func scanStates() -> [ScanStateRow] {
        var out: [ScanStateRow] = []
        run("""
            SELECT sink_key, bytes_scanned, bytes_unreadable, completed, last_seen_at
            FROM dlp_scan_state ORDER BY sink_key
            """) { row in
            out.append(ScanStateRow(
                sinkKey: colText(row, 0) ?? "?",
                bytesScanned: colInt(row, 1),
                bytesUnreadable: colInt(row, 2),
                completed: colInt(row, 3) == 1,
                lastSeenAt: colIntOpt(row, 4)))
        }
        return out
    }

    /// The secret sightings ledger — fingerprints and locations, never values.
    func secretSightings() -> [SecretSighting] {
        var out: [SecretSighting] = []
        run("""
            SELECT id, fingerprint, detector, sink_key, path, byte_offset, byte_length,
                   direction, status, first_seen, last_seen
            FROM secret_sightings ORDER BY status, last_seen DESC LIMIT 500
            """) { row in
            out.append(SecretSighting(
                id: colInt(row, 0),
                fingerprint: colText(row, 1) ?? "?",
                detector: colText(row, 2) ?? "?",
                sinkKey: colText(row, 3) ?? "?",
                path: colText(row, 4) ?? "?",
                byteOffset: colInt(row, 5),
                byteLength: colInt(row, 6),
                direction: colText(row, 7) ?? "at_rest",
                status: colText(row, 8) ?? "candidate",
                firstSeen: colInt(row, 9),
                lastSeen: colInt(row, 10)))
        }
        return out
    }

    /// Token speed — the trailing-window burn rate and the 24h peak minute.
    /// Mirrors getTokenSpeed in queries.ts (same SQL, same instant contract).
    func tokenSpeed(windowMs: Int = 5 * 60_000, now: Int = Int(Date.now.timeIntervalSince1970 * 1000)) -> TokenSpeed {
        let from = now - windowMs
        var byTool: [(tool: String, perMin: Double)] = []
        run("""
            SELECT tool, COALESCE(SUM(total_tokens), 0)
            FROM usage_events WHERE ts >= ? AND ts <= ? AND source = 'live' AND \(tf)
            GROUP BY tool ORDER BY 2 DESC
            """, [from, now]) { row in
            byTool.append((tool: colText(row, 0) ?? "?", perMin: Double(colInt(row, 1)) / (Double(windowMs) / 60_000)))
        }
        var peak = 0.0
        run("""
            SELECT COALESCE(MAX(c), 0) FROM (
              SELECT SUM(total_tokens) AS c
              FROM usage_events WHERE ts >= ? AND source = 'live' AND \(tf)
              GROUP BY CAST(ts / 60000 AS INTEGER))
            """, [now - 24 * 3600_000]) { row in
            peak = Double(colInt(row, 0))
        }
        return TokenSpeed(
            perMin: byTool.reduce(0) { $0 + $1.perMin },
            peakPerMin: peak,
            byTool: byTool.prefix(5).map { ToolSpeed(tool: $0.tool, perMin: $0.perMin) })
    }

    /// Generation speed per tool+model — mirrors getModelSpeeds in queries.ts.
    /// Output tokens per second over rows with a real duration, coverage attached.
    /// kind: 'measured' (the source states the span) or 'turn_scoped' (a gap
    /// estimate — a lower bound on true speed).
    func modelSpeeds(_ r: DateRange) -> [ModelSpeed] {
        let from = r.startMs()
        var out: [ModelSpeed] = []
        run("""
            SELECT tool, model,
                   SUM(CASE WHEN duration_ms IS NOT NULL THEN output_tokens END),
                   SUM(CASE WHEN duration_ms IS NULL THEN output_tokens END),
                   SUM(duration_ms),
                   COUNT(CASE WHEN duration_ms IS NOT NULL THEN 1 END),
                   (SELECT duration_kind FROM usage_events u2
                    WHERE u2.ts >= ? AND u2.tool = usage_events.tool AND u2.model IS usage_events.model
                      AND u2.duration_ms IS NOT NULL
                    GROUP BY duration_kind ORDER BY SUM(duration_ms) DESC LIMIT 1)
            FROM usage_events WHERE ts >= ? AND source = 'live' AND \(tf)
            GROUP BY tool, model HAVING SUM(CASE WHEN duration_ms IS NOT NULL THEN output_tokens END) > 0
                     AND SUM(duration_ms) > 0
            ORDER BY SUM(CASE WHEN duration_ms IS NOT NULL THEN output_tokens END) / SUM(duration_ms) DESC
            """, [from, from]) { row in
            let withDur = colInt(row, 2)
            let withoutDur = colInt(row, 3)
            let durMs = colInt(row, 4)
            out.append(ModelSpeed(
                tool: colText(row, 0) ?? "?",
                model: colText(row, 1),
                tokensPerSecond: durMs > 0 ? Double(withDur) / (Double(durMs) / 1000) : 0,
                medianDurationMs: 0,
                rows: colInt(row, 5),
                coverage: withDur + withoutDur > 0 ? Double(withDur) / Double(withDur + withoutDur) : 0,
                kind: colText(row, 6) == "measured" ? "measured" : "turn_scoped"))
        }
        return out
    }

    /// The tool-call ledger: recent invocations with outcome and authority.
    func toolCalls(limit: Int = 300) -> [ToolCallEntry] {
        var out: [ToolCallEntry] = []
        run("""
            SELECT tool_call_key, tool, name, shape, session_id, agent_id, ts,
                   status, status_source, duration_ms, duration_kind, authority
            FROM tool_calls ORDER BY ts DESC LIMIT ?
            """, [limit]) { row in
            out.append(ToolCallEntry(
                tool: colText(row, 0) ?? "?",
                name: colText(row, 1) ?? "?",
                shape: colText(row, 2),
                sessionID: colText(row, 3),
                agentID: colText(row, 4),
                ts: colInt(row, 5),
                status: colText(row, 6),
                statusSource: colText(row, 7),
                durationMs: colIntOpt(row, 8),
                durationKind: colText(row, 9),
                authority: colText(row, 10)))
        }
        return out
    }

    /// Principals: pseudonymous, never a name or email.
    func principals() -> [PrincipalEntry] {
        var out: [PrincipalEntry] = []
        run("SELECT principal_key, display, first_seen, last_seen FROM principals ORDER BY last_seen DESC") { row in
            out.append(PrincipalEntry(
                principalKey: colText(row, 0) ?? "?",
                display: colText(row, 1) ?? "?",
                firstSeen: colInt(row, 2),
                lastSeen: colInt(row, 3)))
        }
        return out
    }

    func devices() -> [DeviceEntry] {
        var out: [DeviceEntry] = []
        run("SELECT device_key, hostname, first_seen, last_seen FROM devices") { row in
            out.append(DeviceEntry(
                deviceKey: colText(row, 0) ?? "?",
                hostname: colText(row, 1),
                firstSeen: colInt(row, 2),
                lastSeen: colInt(row, 3)))
        }
        return out
    }

    func grants() -> [GrantEntry] {
        var out: [GrantEntry] = []
        run("SELECT grant_key, agent, source_file, kind, entry, first_seen, last_seen FROM grants ORDER BY kind, entry") { row in
            out.append(GrantEntry(
                grantKey: colText(row, 0) ?? "?",
                agent: colText(row, 1) ?? "?",
                sourceFile: colText(row, 2) ?? "?",
                kind: colText(row, 3) ?? "allow",
                entry: colText(row, 4) ?? "",
                firstSeen: colInt(row, 5),
                lastSeen: colInt(row, 6)))
        }
        return out
    }

    /// The subagent tree: sessions grouped by their main/agent split.
    func agentEdges() -> [AgentEdge] {
        var out: [AgentEdge] = []
        run("""
            SELECT COALESCE(session_id, 'none') AS session, COALESCE(agent_id, 'main') AS agent,
                   COUNT(*) AS calls, MIN(ts) AS lo, MAX(ts) AS hi,
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
            FROM tool_calls GROUP BY session, agent ORDER BY calls DESC LIMIT 50
            """) { row in
            out.append(AgentEdge(
                session: colText(row, 0) ?? "none",
                agent: colText(row, 1) ?? "main",
                calls: colInt(row, 2),
                first: colInt(row, 3),
                last: colInt(row, 4),
                errors: colInt(row, 5)))
        }
        return out
    }

    /// The migration ledger — the upgrade boundary: a row with no applied_at
    /// predates the ledger itself and must render as 'unknown', never a date.
    func migrationLedger() -> [MigrationRow] {
        var out: [MigrationRow] = []
        runBound("SELECT version, name, applied_at FROM schema_migrations ORDER BY version", []) { row in
            out.append(MigrationRow(
                version: colInt(row, 0),
                name: colText(row, 1) ?? "?",
                appliedAt: colIntOpt(row, 2)))
        }
        return out
    }

    /// Epoch-ms of the collector's most recent scan cycle (it stamps every source it
    /// touches, every pass). nil if the collector has never run against this database.
    func collectorLastSeen() -> Int? {
        var out: Int?
        run("SELECT MAX(last_scanned_at) FROM collector_state") { out = colIntOpt($0, 0) }
        return out
    }

    /// Read-model parity dump — the Swift twin of
    /// packages/core/src/cli/readmodel-dump.ts, diffed against it in CI. Same
    /// deterministic ordering and the same 1e-6 rounding, so a difference in the
    /// diff is a difference in the read model, never float noise.
    func readModelDump() -> String {
        let s = summary(.all)
        var lines: [String] = ["{"]
        // The schema contract, asserted by the parity diff: known is what THIS app
        // understands, store is the fixture's user_version (always the TS head) —
        // a lagging knownSchemaVersion fails CI here instead of blocking users.
        lines.append("  \"schema\": {\"known\": \(Self.knownSchemaVersion), \"store\": \(schemaVersion())},")
        lines.append("  \"summary\": {")
        lines.append("    \"calls\": \(s.calls),")
        lines.append("    \"tokens\": \(s.tokens),")
        lines.append("    \"cost\": \(jnum(s.cost)),")
        lines.append("    \"sessions\": \(s.sessions),")
        lines.append("    \"errors\": \(s.errors),")
        lines.append("    \"truncated\": \(s.truncated),")
        lines.append("    \"hasActivityOnly\": \(s.hasActivityOnly),")
        lines.append("    \"byTool\": [")
        let tools = s.byTool.sorted { $0.calls == $1.calls ? $0.tool < $1.tool : $0.calls > $1.calls }
        for (i, t) in tools.enumerated() {
            lines.append("      {\"tool\": \"\(t.tool)\", \"calls\": \(t.calls), \"tokens\": \(t.tokens.map(String.init) ?? "null"), \"cost\": \(jnum(t.cost)), \"confidence\": \"\(t.confidence)\", \"activityOnlyCalls\": \(t.activityOnlyCalls)}\(i == tools.count - 1 ? "" : ",")")
        }
        lines.append("    ]")
        lines.append("  },")
        let inc = anomalies(.all, limit: 500)
            .sorted { $0.windowStart == $1.windowStart ? $0.id < $1.id : $0.windowStart > $1.windowStart }
        lines.append("  \"incidents\": [")
        for (i, x) in inc.enumerated() {
            lines.append("    {\"id\": \(x.id), \"anomaly_key\": \"\(jstr(x.anomalyKey))\", \"rule\": \"\(jstr(x.rule))\", \"severity\": \"\(x.severity)\", \"tool\": \"\(jstr(x.tool))\", \"session_id\": \(x.sessionID.map { "\"\(jstr($0))\"" } ?? "null"), \"model\": \(x.model.map { "\"\(jstr($0))\"" } ?? "null"), \"window_start\": \(x.windowStart), \"window_end\": \(x.windowEnd), \"title\": \"\(jstr(x.title))\", \"detail\": \"\(jstr(x.detail))\", \"observed\": \(jnum(x.observed)), \"baseline\": \(jnum(x.baseline)), \"threshold\": \(jnum(x.threshold)), \"confidence\": \"\(x.confidence)\", \"source\": \"\(x.source)\", \"detected_at\": \(x.detectedAt)}\(i == inc.count - 1 ? "" : ",")")
        }
        lines.append("  ],")

        // ── the deep-completion read models: the same contract, extended.
        // Field-for-field with readmodel-dump.ts; jq canonicalises both sides,
        // so only values and null-vs-present can differ.
        let u = ungatedCalls(.all)
        lines.append("  \"ungatedCalls\": {\"calls\": \(u.calls), \"totalCalls\": \(u.totalCalls)},")

        lines.append("  \"filesByWriteClass\": [")
        let fw = filesByWriteClass(.all)
        for (i, r) in fw.enumerated() {
            lines.append("    {\"write_class\": \"\(jstr(r.writeClass))\", \"writes\": \(r.writes), \"unresolved\": \(r.unresolved)}\(i == fw.count - 1 ? "" : ",")")
        }
        lines.append("  ],")

        lines.append("  \"ingressBand\": [")
        let ib = ingressBand(.all)
        for (i, r) in ib.enumerated() {
            lines.append("    {\"url_host\": \(r.urlHost.map { "\"\(jstr($0))\"" } ?? "null"), \"calls\": \(r.calls), \"bytes\": \(r.bytes.map(String.init) ?? "null"), \"statusUnknown\": \(r.statusUnknown)}\(i == ib.count - 1 ? "" : ",")")
        }
        lines.append("  ],")

        lines.append("  \"postureRibbon\": [")
        let pr = postureRibbon(.all, limit: 50)
        for (i, r) in pr.enumerated() {
            lines.append("    {\"session_id\": \"\(jstr(r.sessionID))\", \"autonomy\": \(r.autonomy.map { "\"\(jstr($0))\"" } ?? "null"), \"started_at\": \(r.startedAt), \"ended_at\": \(r.endedAt), \"calls\": \(r.calls), \"denied\": \(r.denied), \"errors\": \(r.errors), \"mode_raw\": \(r.modeRaw.map { "\"\(jstr($0))\"" } ?? "null")}\(i == pr.count - 1 ? "" : ",")")
        }
        lines.append("  ],")

        lines.append("  \"serverToolBilling\": [")
        let st = serverToolBilling(.all)
        for (i, r) in st.enumerated() {
            lines.append("    {\"link_kind\": \"\(jstr(r.linkKind))\", \"requests\": \(r.requests)}\(i == st.count - 1 ? "" : ",")")
        }
        lines.append("  ],")

        lines.append("  \"observationLag\": [")
        let ol = observationLag(.all)
        // JS prints integral doubles bare (194069984, not 194069984.0) — match it.
        let jnum: (Double) -> String = { $0 == $0.rounded() ? String(Int64($0)) : String($0) }
        for (i, r) in ol.enumerated() {
            let p50 = r.p50Ms.map(jnum) ?? "null"
            let p95 = r.p95Ms.map(jnum) ?? "null"
            lines.append("    {\"tool\": \"\(jstr(r.tool))\", \"p50_ms\": \(p50), \"p95_ms\": \(p95), \"observed_rows\": \(r.observedRows)}\(i == ol.count - 1 ? "" : ",")")
        }
        lines.append("  ],")

        lines.append("  \"bulkEgress\": [")
        let be = bulkEgress()
        for (i, r) in be.enumerated() {
            lines.append("    {\"upload_key\": \"\(jstr(r.uploadKey))\", \"repo_path\": \(r.repoPath.map { "\"\(jstr($0))\"" } ?? "null"), \"turn\": \(r.turn.map(String.init) ?? "null"), \"max_file_bytes\": \(r.maxFileBytes.map(String.init) ?? "null"), \"size_bytes\": \(r.sizeBytes.map(String.init) ?? "null"), \"gcs_path\": \(r.gcsPath.map { "\"\(jstr($0))\"" } ?? "null"), \"blobs\": \(r.blobs.map(String.init) ?? "null"), \"uploads_enabled\": \(r.uploadsEnabled.map(String.init) ?? "null"), \"upload_reason\": \(r.uploadReason.map { "\"\(jstr($0))\"" } ?? "null"), \"telemetry_source\": \(r.telemetrySource.map { "\"\(jstr($0))\"" } ?? "null")}\(i == be.count - 1 ? "" : ",")")
        }
        lines.append("  ],")

        lines.append("  \"mcpServers\": [")
        let mc = mcpServersGroup()
        for (i, r) in mc.enumerated() {
            lines.append("    {\"server_name\": \"\(jstr(r.serverName))\", \"mcp_identity\": \"\(jstr(r.mcpIdentity))\", \"clients\": \(r.clients), \"transport\": \(r.transport.map { "\"\(jstr($0))\"" } ?? "null"), \"enabled\": \(r.enabled.map(String.init) ?? "null")}\(i == mc.count - 1 ? "" : ",")")
        }
        lines.append("  ],")

        lines.append("  \"blastRadius\": [")
        let br = blastTargets(.all)
        for (i, r) in br.enumerated() {
            lines.append("    {\"target_kind\": \"\(jstr(r.targetKind))\", \"target_label\": \(r.targetLabel.map { "\"\(jstr($0))\"" } ?? "null"), \"locality\": \(r.locality.map { "\"\(jstr($0))\"" } ?? "null"), \"env_class\": \(r.envClass.map { "\"\(jstr($0))\"" } ?? "null"), \"calls\": \(r.calls), \"writes\": \(r.writes), \"vcs_actions\": \(r.vcsActions), \"package_execs\": \(r.packageExecs)}\(i == br.count - 1 ? "" : ",")")
        }
        lines.append("  ],")

        lines.append("  \"aiSurfaces\": [")
        let asr = aiSurfaceRows().prefix(50)
        for (i, r) in asr.enumerated() {
            lines.append("    {\"surface_key\": \"\(jstr(r.surfaceKey))\", \"kind\": \"\(jstr(r.kind))\", \"name\": \"\(jstr(r.name))\", \"path\": \(r.path.map { "\"\(jstr($0))\"" } ?? "null"), \"sanctioned\": \(r.sanctioned.json), \"version\": \(r.version.map { "\"\(jstr($0))\"" } ?? "null"), \"first_seen\": \(r.firstSeen), \"last_seen\": \(r.lastSeen)}\(i == asr.count - 1 ? "" : ",")")
        }
        lines.append("  ]")
        lines.append("}")
        return lines.joined(separator: "\n")
    }

    /// One heartbeat per collector — its latest pass, written even when the pass found
    /// nothing. `collector_state` above is per-FILE and only Claude Code writes it, so
    /// a Codex- or OpenCode-only Mac used to read as "Setting up…" forever.
    func collectorHeartbeats() -> [CollectorHeartbeat] {        var out: [CollectorHeartbeat] = []
        run("""
            SELECT tool, started_at, duration_ms, files, parsed, inserted, source_state, ok
            FROM collector_runs cr
            WHERE started_at = (SELECT MAX(started_at) FROM collector_runs c2 WHERE c2.tool = cr.tool)
            ORDER BY tool
            """) { row in
            out.append(CollectorHeartbeat(
                tool: colText(row, 0) ?? "?",
                startedAt: colInt(row, 1), durationMs: colInt(row, 2),
                files: colInt(row, 3), parsed: colInt(row, 4), inserted: colInt(row, 5),
                sourceState: colText(row, 6) ?? "ok", ok: colInt(row, 7) == 1))
        }
        // A store written before collector_runs existed has none of these rows; the
        // per-file watermark is the only liveness fact left, so use it rather than
        // reading a pre-upgrade store as dead.
        if out.isEmpty, let legacy = collectorLastSeen() {
            out.append(CollectorHeartbeat(
                tool: "claude_code", startedAt: legacy, durationMs: 0,
                files: 0, parsed: 0, inserted: 0, sourceState: "ok", ok: true))
        }
        return out
    }

    func breakdown(_ r: DateRange) -> [BreakdownRow] {
        let from = r.startMs()
        var out: [BreakdownRow] = []
        run("""
            SELECT tool, model, confidence, COUNT(*),
                   CASE WHEN confidence = 'activity_only' THEN NULL
                        ELSE COALESCE(SUM(total_tokens), 0) END AS tokens,
                   SUM(cost_usd),
                   CASE WHEN confidence = 'activity_only' THEN NULL
                        ELSE COALESCE(SUM(cache_read_tokens), 0) END,
                   CASE WHEN confidence = 'activity_only' THEN NULL
                        ELSE COALESCE(SUM(output_tokens), 0) END
            FROM usage_events WHERE ts >= ? AND source = 'live'
            GROUP BY tool, model, confidence
            ORDER BY (tokens IS NULL), tokens DESC
            """, [from]) { row in
            out.append(BreakdownRow(
                tool: colText(row, 0) ?? "?", model: colText(row, 1),
                confidence: colText(row, 2) ?? "exact", calls: colInt(row, 3),
                tokens: colIntOpt(row, 4), cost: colDblOpt(row, 5),
                cacheRead: colIntOpt(row, 6), output: colIntOpt(row, 7)))
        }
        return out
    }

    // MARK: deep-completion read models (tiers 3-8) — ports of queries.ts

    /// The People view's principal dimension (parity port of getByPrincipal):
    /// live-only, every figure verbatim, binding coverage spelled out.
    ///
    /// MUST stay in lockstep with getByPrincipal in queries.ts: the join is
    /// usage_events -> session_identity.principal_key -> principals, in pure SQL.
    /// The reader never hashes — usage_events.user is cleartext and is never
    /// matched against the keyed principals.principal_key (the old join did
    /// exactly that and matched nothing).
    func byPrincipal() -> (principals: [PrincipalSummaryRow], originUnknownCalls: Int, originUnknownTokens: Int?) {
        var keys: [String] = []
        run("""
            SELECT DISTINCT si.principal_key FROM usage_events e
            JOIN session_identity si ON si.session_id = e.session_id
            WHERE si.principal_key IS NOT NULL AND e.source = 'live'
            """) { row in
            if let k = colText(row, 0) { keys.append(k) }
        }
        var out: [PrincipalSummaryRow] = []
        for key in keys {
            var outKey = "unknown:\(key)"
            var display = key
            runBound("SELECT principal_key, display FROM principals WHERE principal_key = ?", [.text(key)]) { row in
                outKey = colText(row, 0) ?? "unknown:\(key)"
                display = colText(row, 1) ?? key
            }
            var sessions = 0, calls = 0
            var tokens: Int? = nil, cost: Double? = nil
            runBound("""
                SELECT COUNT(DISTINCT e.session_id) AS sessions, COUNT(*) AS calls,
                       SUM(e.total_tokens) AS tokens, SUM(e.cost_usd) AS cost
                FROM usage_events e JOIN session_identity si ON si.session_id = e.session_id
                WHERE si.principal_key = ? AND e.source = 'live'
                """, [.text(key)]) { row in
                sessions = colInt(row, 0); calls = colInt(row, 1)
                tokens = colIntOpt(row, 2); cost = colDblOpt(row, 3)
            }
            var info = 0, warn = 0, critical = 0
            runBound("""
                SELECT severity, COUNT(*) AS n FROM anomalies a
                JOIN session_identity si ON si.session_id = a.session_id
                WHERE si.principal_key = ? GROUP BY severity
                """, [.text(key)]) { row in
                switch colText(row, 0) {
                case "info": info = colInt(row, 1)
                case "warn": warn = colInt(row, 1)
                case "critical": critical = colInt(row, 1)
                default: break
                }
            }
            var classes: [(tool: String?, accountClass: String?, sessions: Int)] = []
            runBound("""
                SELECT tool, account_class, COUNT(DISTINCT session_id) AS n FROM session_identity
                WHERE principal_key = ? GROUP BY tool, account_class ORDER BY n DESC
                """, [.text(key)]) { row in
                classes.append((colText(row, 0), colText(row, 1), colInt(row, 2)))
            }
            var proved = 0, ambient = 0, unbound = 0
            runBound("SELECT binding_evidence, COUNT(*) AS n FROM session_identity WHERE principal_key = ? GROUP BY binding_evidence", [.text(key)]) { row in
                switch colText(row, 0) {
                case "session_proved": proved = colInt(row, 1)
                case "ambient": ambient = colInt(row, 1)
                default: unbound += colInt(row, 1)
                }
            }
            // Sessions counted here all have an identity row by construction (the
            // join is through it); live sessions with no identity row at all fall
            // to the origin-unknown bucket below, never to a principal.
            out.append(PrincipalSummaryRow(
                principalKey: outKey, display: display, sessions: sessions, calls: calls,
                tokens: tokens, costUsd: cost, info: info, warn: warn, critical: critical,
                sessionProved: proved, ambient: ambient, unbound: unbound,
                noIdentityRow: 0,
                accountClasses: classes))
        }
        out.sort { $0.calls == $1.calls ? $0.principalKey < $1.principalKey : $0.calls > $1.calls }
        var calls = 0
        var tokens: Int? = nil
        run("""
            SELECT COUNT(*) AS calls, SUM(e.total_tokens) AS tokens
            FROM usage_events e LEFT JOIN session_identity si ON si.session_id = e.session_id
            WHERE e.source = 'live' AND si.principal_key IS NULL
            """) { row in
            calls = colInt(row, 0); tokens = colIntOpt(row, 1)
        }
        return (out, calls, tokens)
    }

    /// The ungated-call KPI: calls that ran with no gate at all (bypass_no_gate).
    func ungatedCalls(_ r: DateRange) -> UngatedCallCounts {
        let from = r.startMs()
        var total = 0, ungated = 0
        run("SELECT COUNT(*) AS n FROM tool_calls WHERE ts >= ?", [from]) { total = colInt($0, 0) }
        run("SELECT COUNT(*) AS n FROM tool_calls WHERE ts >= ? AND authorization_basis = 'bypass_no_gate'", [from]) { ungated = colInt($0, 0) }
        return UngatedCallCounts(calls: ungated, totalCalls: total)
    }

    /// Blast Radius: action_targets joined to the child ledgers' scope reach.
    func blastTargets(_ r: DateRange) -> [BlastTargetRow] {
        let from = r.startMs()
        var rows: [BlastTargetRow] = []
        run("""
            SELECT target_kind, target_label, locality, env_class, COUNT(DISTINCT call_key) AS calls
            FROM action_targets WHERE last_seen >= ? GROUP BY target_kind, target_label, locality, env_class
            """, [from]) { row in
            rows.append(BlastTargetRow(
                targetKind: colText(row, 0) ?? "?", targetLabel: colText(row, 1),
                locality: colText(row, 2), envClass: colText(row, 3), calls: colInt(row, 4)))
        }
        var writes = 0, vcs = 0, pkgs = 0
        run("SELECT COUNT(*) AS n FROM file_writes WHERE ts >= ?", [from]) { writes = colInt($0, 0) }
        run("SELECT COUNT(*) AS n FROM vcs_actions WHERE ts >= ?", [from]) { vcs = colInt($0, 0) }
        run("SELECT COUNT(*) AS n FROM package_execs WHERE ts >= ?", [from]) { pkgs = colInt($0, 0) }
        for i in rows.indices {
            rows[i].writes = writes
            rows[i].vcsActions = vcs
            rows[i].packageExecs = pkgs
        }
        rows.sort { $0.calls == $1.calls ? $0.targetKind < $1.targetKind : $0.calls > $1.calls }
        return rows
    }

    /// The Files tab: writes split by write_class, unresolved targets counted.
    func filesByWriteClass(_ r: DateRange) -> [WriteClassRow] {
        let from = r.startMs()
        var out: [WriteClassRow] = []
        run("""
            SELECT COALESCE(write_class, 'unresolved') AS write_class, COUNT(*) AS n
            FROM file_writes WHERE ts >= ? GROUP BY write_class ORDER BY n DESC
            """, [from]) { row in
            out.append(WriteClassRow(writeClass: colText(row, 0) ?? "?", writes: colInt(row, 1), unresolved: 0))
        }
        var unresolved = 0
        run("SELECT COUNT(*) AS n FROM file_writes WHERE ts >= ? AND path IS NULL", [from]) { unresolved = colInt($0, 0) }
        for i in out.indices { out[i].unresolved = unresolved }
        return out
    }

    /// The ingress band: fetch ingress by host, with NULL-status counts.
    func ingressBand(_ r: DateRange) -> [IngressHostRow] {
        let from = r.startMs()
        var out: [IngressHostRow] = []
        run("""
            SELECT url_host, COUNT(*) AS calls, SUM(bytes) AS bytes,
                   SUM(CASE WHEN status IS NULL THEN 1 ELSE 0 END) AS statusUnknown
            FROM fetch_ingress WHERE ts >= ? GROUP BY url_host ORDER BY calls DESC
            """, [from]) { row in
            out.append(IngressHostRow(
                urlHost: colText(row, 0), calls: colInt(row, 1),
                bytes: colIntOpt(row, 2), statusUnknown: colInt(row, 3)))
        }
        return out
    }

    /// The posture ribbon: the autonomy timeline, newest intervals first.
    func postureRibbon(_ r: DateRange, limit: Int = 200) -> [AutonomyInterval] {
        let from = r.startMs()
        var out: [AutonomyInterval] = []
        run("""
            SELECT session_id, autonomy, started_at, ended_at, calls, denied, errors, mode_raw
            FROM autonomy_intervals WHERE ended_at >= ? ORDER BY ended_at DESC LIMIT ?
            """, [from, limit]) { row in
            out.append(AutonomyInterval(
                sessionID: colText(row, 0) ?? "?", autonomy: colText(row, 1),
                startedAt: colInt(row, 2), endedAt: colInt(row, 3),
                calls: colInt(row, 4), denied: colInt(row, 5), errors: colInt(row, 6),
                modeRaw: colText(row, 7)))
        }
        return out
    }

    /// Server-tool billing: the event_links request counters the vendors bill on.
    func serverToolBilling(_ r: DateRange) -> [ServerToolRow] {
        let from = r.startMs()
        var out: [ServerToolRow] = []
        run("""
            SELECT link_kind, SUM(CAST(link_id AS INTEGER)) AS requests FROM event_links
            WHERE link_kind IN ('web_search_requests','web_fetch_requests') AND first_seen >= ? GROUP BY link_kind
            """, [from]) { row in
            out.append(ServerToolRow(linkKind: colText(row, 0) ?? "?", requests: colInt(row, 1)))
        }
        return out
    }

    /// Observation lag: per tool, observed_at minus ts (the collection-delay read model).
    func observationLag(_ r: DateRange) -> [LagRow] {
        let from = r.startMs()
        var byTool: [String: [Double]] = [:]
        run("""
            SELECT tool, observed_at - ts AS lag FROM usage_events
            WHERE ts >= ? AND observed_at IS NOT NULL AND source = 'live'
            """, [from]) { row in
            byTool[colText(row, 0) ?? "?", default: []].append(colDblOpt(row, 1) ?? 0)
        }
        return byTool.map { tool, lags -> LagRow in
            let sorted = lags.sorted()
            // Same index math as queries.ts: floor((p/100) * n), capped at n-1.
            let pct = { (p: Int) -> Double? in
                sorted.isEmpty ? nil : sorted[min(sorted.count - 1, (p * sorted.count) / 100)]
            }
            return LagRow(tool: tool, p50Ms: pct(50), p95Ms: pct(95), observedRows: sorted.count)
        }.sorted { $0.tool < $1.tool }
    }

    /// Grok's repo_state uploads (tier 5 #7): the Bulk Egress card on Posture.
    func bulkEgress() -> [BulkEgressEntry] {
        var out: [BulkEgressEntry] = []
        run("""
            SELECT b.upload_key, b.repo_path, b.turn, b.max_file_bytes, b.size_bytes, b.gcs_path, b.blobs,
                   d.uploads_enabled, d.upload_reason, d.telemetry_source
            FROM bulk_uploads b LEFT JOIN upload_decisions d ON d.upload_key = b.upload_key
            ORDER BY b.started_at DESC
            """) { row in
            out.append(BulkEgressEntry(
                uploadKey: colText(row, 0) ?? "?", repoPath: colText(row, 1),
                turn: colIntOpt(row, 2), maxFileBytes: colIntOpt(row, 3),
                sizeBytes: colIntOpt(row, 4), gcsPath: colText(row, 5),
                blobs: colIntOpt(row, 6), uploadsEnabled: colIntOpt(row, 7),
                uploadReason: colText(row, 8), telemetrySource: colText(row, 9)))
        }
        return out
    }

    /// The MCP dimension: configured servers grouped by identity, observed-only split.
    func mcpServersGroup() -> [McpServerRow] {
        var out: [McpServerRow] = []
        run("""
            SELECT server_name, mcp_identity, COUNT(DISTINCT client) AS clients, transport, MAX(enabled)
            FROM posture_mcp_servers GROUP BY server_name, mcp_identity, transport
            ORDER BY server_name
            """) { row in
            out.append(McpServerRow(
                serverName: colText(row, 0) ?? "?", mcpIdentity: colText(row, 1) ?? "?",
                clients: colInt(row, 2), transport: colText(row, 3), enabled: colIntOpt(row, 4)))
        }
        return out
    }

    /// The ai_surfaces read model (port of getAiSurfaces).
    func aiSurfaceRows() -> [AiSurfaceRow] {
        var out: [AiSurfaceRow] = []
        run("""
            SELECT surface_key, kind, name, path, sanctioned, version, first_seen, last_seen
            FROM ai_surfaces ORDER BY surface_key
            """) { row in
            out.append(AiSurfaceRow(
                surfaceKey: colText(row, 0) ?? "?", kind: colText(row, 1) ?? "?",
                name: colText(row, 2) ?? "?", path: colText(row, 3),
                sanctioned: colRaw(row, 4), version: colText(row, 5),
                firstSeen: colInt(row, 6), lastSeen: colInt(row, 7)))
        }
        return out
    }
}
