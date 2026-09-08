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


/// One autonomy interval: a session's agent-run timeline segment.
/// Mirrors queries.ts postureRibbon — the parity dump diffs the two.
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

/// One server-tool billing counter (event_links): billed per request, not per token.
/// Mirrors queries.ts serverToolBilling.
struct ServerToolRow: Identifiable {
    let linkKind: String
    let requests: Int
    var id: String { linkKind }
}

/// One observation-lag measurement per tool (observed_at - ts).
/// Mirrors queries.ts observationLag; nil percentiles mean unknown, never zero.
struct LagRow: Identifiable {
    let tool: String
    let p50Ms: Double?
    let p95Ms: Double?
    let observedRows: Int
    var id: String { tool }
}

/// One bulk upload with its telemetry decision. Mirrors queries.ts bulkEgress.
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

/// One configured MCP server grouped by identity. Mirrors queries.ts mcpServersGroup.
struct McpServerRow: Identifiable {
    let serverName: String
    let mcpIdentity: String
    let clients: Int
    let transport: String?
    let enabled: Int?
    var id: String { "\(serverName):\(mcpIdentity):\(transport ?? "-")" }
}

/// The tool-call ledger's ingress host ranking.
struct IngressHostEntry: Identifiable {
    let host: String
    let hits: Int
    let lastTs: Int
    var id: String { host }
}

/// One remote target from action_targets, with the child ledgers' scope reach.
/// Mirrors queries.ts blastRadius.
struct BlastTargetRow: Identifiable {
    let targetKind: String
    let targetLabel: String?
    let locality: String?
    let envClass: String?
    let calls: Int
    let writes: Int
    let vcsActions: Int
    let packageExecs: Int
    var id: String { "\(targetKind):\(targetLabel ?? "-"):\(locality ?? "-"):\(envClass ?? "-")" }
}

/// One write class from file_writes, with the unresolved-path count carried on
/// every row (counted, never dropped). Mirrors queries.ts filesByWriteClass.
struct WriteClassRow: Identifiable {
    let writeClass: String
    let writes: Int
    let unresolved: Int
    var id: String { writeClass }
}

/// One external host that sent bytes into a session (fetch_ingress).
/// Mirrors queries.ts ingressBand; NULL bytes/status mean unknown, never zero.
struct IngressHostRow: Identifiable {
    let urlHost: String?
    let calls: Int
    let bytes: Int?
    let statusUnknown: Int
    let lastTs: Int
    var id: String { urlHost ?? "(no host)" }
}

/// The People-view summary: a principal with their scoped figures.
struct PrincipalSummaryRow: Identifiable {
    let principalKey: String
    let display: String
    let sessions: Int
    let calls: Int
    let tokens: Int?
    let cost: Double?
    let firstSeen: Int
    let lastSeen: Int
    var id: String { principalKey }
}

/// The ungated-call KPI (bypass_no_gate): counts by authority state.
/// Calls that ran with no permission gate at all, over the calls recorded in
/// range. Mirrors queries.ts ungatedCalls — zero is a real figure, so this is
/// never optional: "0 of 0" and "no data" are different sentences.
struct UngatedCallCounts: Equatable {
    let calls: Int
    let totalCalls: Int
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

// JSON helpers for the parity dump: 1e-6 rounding on both sides means the diff
// shows read-model differences, never last-digit float noise between runtimes.
private func jnum(_ x: Double?) -> String {
    guard let x else { return "null" }
    return String(format: "%.6g", (x * 1e6).rounded() / 1e6)
}
private func jstr(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n")
}

/// A JSON string-or-null and a JSON int-or-null. The parity diff treats a missing
/// figure as null on both sides — never 0, never "".
private func jtext(_ s: String?) -> String { s.map { "\"\(jstr($0))\"" } ?? "null" }
private func jint(_ n: Int?) -> String { n.map(String.init) ?? "null" }

/// A column emitted with SQLite's own type. `ai_surfaces.sanctioned` is declared
/// INTEGER but holds 'true' — better-sqlite3 hands the TS side that TEXT verbatim,
/// so reading it as an Int here would print `0` against the TS side's `"true"`.
private func jcol(_ s: OpaquePointer, _ i: Int32) -> String {
    switch sqlite3_column_type(s, i) {
    case SQLITE_NULL: return "null"
    case SQLITE_INTEGER: return String(colInt(s, i))
    case SQLITE_FLOAT: return jnum(sqlite3_column_double(s, i))
    default: return jtext(colText(s, i))
    }
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
            handle = h; opened = true
        } else if sqlite3_open_v2(path, &h, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK {
            // ponytail: WAL databases sometimes refuse a pure READONLY connection;
            // the file is user-writable, so fall back rather than show nothing.
            handle = h; opened = true
        }
        if let handle { sqlite3_busy_timeout(handle, 2000) }
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

    /// One COUNT(*)-shaped answer. The child-ledger totals a Blast Radius row
    /// carries are all this shape, and a missing table must read 0, never crash.
    private func scalar(_ sql: String, _ bind: Int) -> Int {
        var n = 0
        run(sql, [bind]) { n = colInt($0, 0) }
        return n
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
    /// Blast Radius: action_targets with the child ledgers' scope reach.
    /// The Swift twin of queries.ts blastRadius — same grouping, same tie-break.
    func blastTargets(_ r: DateRange) -> [BlastTargetRow] {
        let from = r.startMs()
        let writes = scalar("SELECT COUNT(*) FROM file_writes WHERE ts >= ?", from)
        let vcs = scalar("SELECT COUNT(*) FROM vcs_actions WHERE ts >= ?", from)
        let pkgs = scalar("SELECT COUNT(*) FROM package_execs WHERE ts >= ?", from)
        var out: [BlastTargetRow] = []
        run("""
            SELECT target_kind, target_label, locality, env_class, COUNT(DISTINCT call_key) AS calls
            FROM action_targets WHERE last_seen >= ?
            GROUP BY target_kind, target_label, locality, env_class
            """, [from]) { row in
            out.append(BlastTargetRow(
                targetKind: colText(row, 0) ?? "?",
                targetLabel: colText(row, 1),
                locality: colText(row, 2),
                envClass: colText(row, 3),
                calls: colInt(row, 4),
                writes: writes, vcsActions: vcs, packageExecs: pkgs))
        }
        return out.sorted { $0.calls == $1.calls ? $0.targetKind < $1.targetKind : $0.calls > $1.calls }
    }

    /// The Files tab: writes split by write_class, unresolved paths counted on
    /// every row — never dropped. The twin of queries.ts filesByWriteClass.
    func writeClasses(_ r: DateRange) -> [WriteClassRow] {
        let from = r.startMs()
        let unresolved = scalar("SELECT COUNT(*) FROM file_writes WHERE ts >= ? AND path IS NULL", from)
        var out: [WriteClassRow] = []
        run("""
            SELECT COALESCE(write_class, 'unresolved') AS write_class, COUNT(*) AS n
            FROM file_writes WHERE ts >= ? GROUP BY write_class ORDER BY n DESC
            """, [from]) { row in
            out.append(WriteClassRow(
                writeClass: colText(row, 0) ?? "unresolved",
                writes: colInt(row, 1),
                unresolved: unresolved))
        }
        return out
    }

    /// The ingress band: fetch ingress by host, NULL status counted as unknown —
    /// never zero. The twin of queries.ts ingressBand (lastTs is app-only chrome).
    func ingressHosts(_ r: DateRange) -> [IngressHostRow] {
        let from = r.startMs()
        var out: [IngressHostRow] = []
        run("""
            SELECT url_host, COUNT(*) AS calls, SUM(bytes) AS bytes,
                   SUM(CASE WHEN status IS NULL THEN 1 ELSE 0 END) AS statusUnknown,
                   COALESCE(MAX(ts), 0) AS lastTs
            FROM fetch_ingress WHERE ts >= ? GROUP BY url_host ORDER BY calls DESC
            """, [from]) { row in
            out.append(IngressHostRow(
                urlHost: colText(row, 0),
                calls: colInt(row, 1),
                bytes: colIntOpt(row, 2),
                statusUnknown: colInt(row, 3),
                lastTs: colInt(row, 4)))
        }
        return out
    }

    /// The posture ribbon: the autonomy timeline, newest intervals first.
    /// The twin of queries.ts postureRibbon.
    func autonomyIntervals(_ r: DateRange, limit: Int = 200) -> [AutonomyInterval] {
        let from = r.startMs()
        var out: [AutonomyInterval] = []
        run("""
            SELECT session_id, autonomy, started_at, ended_at, calls, denied, errors, mode_raw
            FROM autonomy_intervals WHERE ended_at >= ? ORDER BY ended_at DESC LIMIT ?
            """, [from, limit]) { row in
            out.append(AutonomyInterval(
                sessionID: colText(row, 0) ?? "?",
                autonomy: colText(row, 1),
                startedAt: colInt(row, 2),
                endedAt: colInt(row, 3),
                calls: colInt(row, 4),
                denied: colInt(row, 5),
                errors: colInt(row, 6),
                modeRaw: colText(row, 7)))
        }
        return out
    }

    /// Server-tool billing: the event_links counters the vendor bills as its own
    /// line item. The twin of queries.ts serverToolBilling.
    func serverTools(_ r: DateRange) -> [ServerToolRow] {
        let from = r.startMs()
        var out: [ServerToolRow] = []
        run("""
            SELECT link_kind, SUM(CAST(link_id AS INTEGER)) AS requests FROM event_links
            WHERE link_kind IN ('web_search_requests','web_fetch_requests') AND first_seen >= ?
            GROUP BY link_kind
            """, [from]) { row in
            out.append(ServerToolRow(linkKind: colText(row, 0) ?? "?", requests: colInt(row, 1)))
        }
        return out
    }

    /// Observation lag per tool: observed_at minus ts over live rows. The
    /// percentile pick is queries.ts's exactly — index floor(p/100 * n), clamped —
    /// because a different rounding rule is a parity diff, not a nicety.
    func observationLags(_ r: DateRange) -> [LagRow] {
        let from = r.startMs()
        var byTool: [String: [Double]] = [:]
        run("""
            SELECT tool, observed_at - ts AS lag FROM usage_events
            WHERE ts >= ? AND observed_at IS NOT NULL AND source = 'live'
            """, [from]) { row in
            byTool[colText(row, 0) ?? "?", default: []].append(Double(colInt(row, 1)))
        }
        func pct(_ sorted: [Double], _ p: Double) -> Double? {
            guard !sorted.isEmpty else { return nil }
            return sorted[min(sorted.count - 1, Int((p / 100) * Double(sorted.count)))]
        }
        return byTool.map { tool, lags -> LagRow in
            let sorted = lags.sorted()
            return LagRow(tool: tool, p50Ms: pct(sorted, 50), p95Ms: pct(sorted, 95), observedRows: sorted.count)
        }.sorted { $0.tool < $1.tool }
    }

    /// Bulk uploads joined to their telemetry decision. The twin of queries.ts bulkEgress.
    func bulkEgress() -> [BulkEgressEntry] {
        var out: [BulkEgressEntry] = []
        run("""
            SELECT b.upload_key, b.repo_path, b.turn, b.max_file_bytes, b.size_bytes, b.gcs_path, b.blobs,
                   d.uploads_enabled, d.upload_reason, d.telemetry_source
            FROM bulk_uploads b LEFT JOIN upload_decisions d ON d.upload_key = b.upload_key
            ORDER BY b.started_at DESC
            """) { row in
            out.append(BulkEgressEntry(
                uploadKey: colText(row, 0) ?? "?",
                repoPath: colText(row, 1),
                turn: colIntOpt(row, 2),
                maxFileBytes: colIntOpt(row, 3),
                sizeBytes: colIntOpt(row, 4),
                gcsPath: colText(row, 5),
                blobs: colIntOpt(row, 6),
                uploadsEnabled: colIntOpt(row, 7),
                uploadReason: colText(row, 8),
                telemetrySource: colText(row, 9)))
        }
        return out
    }

    /// Configured MCP servers grouped by identity. The twin of queries.ts mcpServersGroup.
    func mcpServers() -> [McpServerRow] {
        var out: [McpServerRow] = []
        run("""
            SELECT server_name, mcp_identity, COUNT(DISTINCT client) AS clients, transport, MAX(enabled) AS enabled
            FROM posture_mcp_servers GROUP BY server_name, mcp_identity, transport
            ORDER BY server_name
            """) { row in
            out.append(McpServerRow(
                serverName: colText(row, 0) ?? "?",
                mcpIdentity: colText(row, 1) ?? "?",
                clients: colInt(row, 2),
                transport: colText(row, 3),
                enabled: colIntOpt(row, 4)))
        }
        return out
    }

    func principalSummary(_ r: DateRange) -> [PrincipalSummaryRow] {
        let from = r.startMs()
        var out: [PrincipalSummaryRow] = []
        run("""
            SELECT p.principal_key, p.display,
                   (SELECT COUNT(DISTINCT u.session_id) FROM usage_events u WHERE u.session_id = si.session_id AND u.ts >= ?),
                   (SELECT COUNT(*) FROM usage_events u WHERE u.session_id = si.session_id AND u.ts >= ?),
                   (SELECT SUM(u.total_tokens) FROM usage_events u WHERE u.session_id = si.session_id AND u.ts >= ?),
                   (SELECT SUM(u.cost_usd) FROM usage_events u WHERE u.session_id = si.session_id AND u.ts >= ?),
                   p.first_seen, p.last_seen
            FROM principals p
            LEFT JOIN session_identity si ON si.principal_key = p.principal_key
            GROUP BY p.principal_key ORDER BY p.last_seen DESC
            """, [from, from, from, from]) { row in
            out.append(PrincipalSummaryRow(
                principalKey: colText(row, 0) ?? "?",
                display: colText(row, 1) ?? "?",
                sessions: colInt(row, 2),
                calls: colInt(row, 3),
                tokens: colIntOpt(row, 4),
                cost: colDblOpt(row, 5),
                firstSeen: colInt(row, 6),
                lastSeen: colInt(row, 7)))
        }
        return out
    }

    /// The twin of queries.ts ungatedCalls: the bypass_no_gate count and the
    /// denominator it must always be read against.
    func ungatedCallCounts(_ r: DateRange) -> UngatedCallCounts {
        let from = r.startMs()
        return UngatedCallCounts(
            calls: scalar("SELECT COUNT(*) FROM tool_calls WHERE ts >= ? AND authorization_basis = 'bypass_no_gate'", from),
            totalCalls: scalar("SELECT COUNT(*) FROM tool_calls WHERE ts >= ?", from))
    }

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
            let tokStr = t.tokens.map(String.init) ?? "null"
            let comma = i == tools.count - 1 ? "" : ","
            lines.append("      {\"tool\": \"\(t.tool)\", \"calls\": \(t.calls), \"tokens\": \(tokStr), \"cost\": \(jnum(t.cost)), \"confidence\": \"\(t.confidence)\", \"activityOnlyCalls\": \(t.activityOnlyCalls)}\(comma)")
        }
        lines.append("    ]")
        lines.append("  },")
        let inc = anomalies(.all, limit: 500)
            .sorted { $0.windowStart == $1.windowStart ? $0.id < $1.id : $0.windowStart > $1.windowStart }
        lines.append("  \"incidents\": [")
        for (i, x) in inc.enumerated() {
            let sidStr = x.sessionID.map { "\"\(jstr($0))\"" } ?? "null"
            let mdlStr = x.model.map { "\"\(jstr($0))\"" } ?? "null"
            let comma2 = i == inc.count - 1 ? "" : ","
            lines.append("    {\"id\": \(x.id), \"anomaly_key\": \"\(jstr(x.anomalyKey))\", \"rule\": \"\(jstr(x.rule))\", \"severity\": \"\(x.severity)\", \"tool\": \"\(jstr(x.tool))\", \"session_id\": \(sidStr), \"model\": \(mdlStr), \"window_start\": \(x.windowStart), \"window_end\": \(x.windowEnd), \"title\": \"\(jstr(x.title))\", \"detail\": \"\(jstr(x.detail))\", \"observed\": \(jnum(x.observed)), \"baseline\": \(jnum(x.baseline)), \"threshold\": \(jnum(x.threshold)), \"confidence\": \"\(x.confidence)\", \"source\": \"\(x.source)\", \"detected_at\": \(x.detectedAt)}\(comma2)")
        }
        lines.append("  ],")

        // ── the deep-completion read models: the same contract, extended ──
        // Each block is the twin of the matching entry in readmodel-dump.ts; the
        // CI diff is the only thing keeping the two readers honest.
        let ug = ungatedCallCounts(.all)
        lines.append("  \"ungatedCalls\": {\"calls\": \(ug.calls), \"totalCalls\": \(ug.totalCalls)},")

        lines.append(jsonList("filesByWriteClass", writeClasses(.all)) { w in
            "{\"write_class\": \(jtext(w.writeClass)), \"writes\": \(w.writes), \"unresolved\": \(w.unresolved)}"
        })
        lines.append(jsonList("ingressBand", ingressHosts(.all)) { h in
            "{\"url_host\": \(jtext(h.urlHost)), \"calls\": \(h.calls), \"bytes\": \(jint(h.bytes)), \"statusUnknown\": \(h.statusUnknown)}"
        })
        lines.append(jsonList("postureRibbon", autonomyIntervals(.all, limit: 50)) { a in
            "{\"session_id\": \(jtext(a.sessionID)), \"autonomy\": \(jtext(a.autonomy)), \"started_at\": \(a.startedAt), \"ended_at\": \(a.endedAt), \"calls\": \(a.calls), \"denied\": \(a.denied), \"errors\": \(a.errors), \"mode_raw\": \(jtext(a.modeRaw))}"
        })
        lines.append(jsonList("serverToolBilling", serverTools(.all)) { t in
            "{\"link_kind\": \(jtext(t.linkKind)), \"requests\": \(t.requests)}"
        })
        lines.append(jsonList("observationLag", observationLags(.all)) { l in
            "{\"tool\": \(jtext(l.tool)), \"p50_ms\": \(jnum(l.p50Ms)), \"p95_ms\": \(jnum(l.p95Ms)), \"observed_rows\": \(l.observedRows)}"
        })
        lines.append(jsonList("bulkEgress", bulkEgress()) { b in
            "{\"upload_key\": \(jtext(b.uploadKey)), \"repo_path\": \(jtext(b.repoPath)), \"turn\": \(jint(b.turn)), \"max_file_bytes\": \(jint(b.maxFileBytes)), \"size_bytes\": \(jint(b.sizeBytes)), \"gcs_path\": \(jtext(b.gcsPath)), \"blobs\": \(jint(b.blobs)), \"uploads_enabled\": \(jint(b.uploadsEnabled)), \"upload_reason\": \(jtext(b.uploadReason)), \"telemetry_source\": \(jtext(b.telemetrySource))}"
        })
        lines.append(jsonList("mcpServers", mcpServers()) { m in
            "{\"server_name\": \(jtext(m.serverName)), \"mcp_identity\": \(jtext(m.mcpIdentity)), \"clients\": \(m.clients), \"transport\": \(jtext(m.transport)), \"enabled\": \(jint(m.enabled))}"
        })
        lines.append(jsonList("blastRadius", blastTargets(.all)) { b in
            "{\"target_kind\": \(jtext(b.targetKind)), \"target_label\": \(jtext(b.targetLabel)), \"locality\": \(jtext(b.locality)), \"env_class\": \(jtext(b.envClass)), \"calls\": \(b.calls), \"writes\": \(b.writes), \"vcs_actions\": \(b.vcsActions), \"package_execs\": \(b.packageExecs)}"
        })
        lines.append(jsonList("aiSurfaces", aiSurfacesDump(), trailingComma: false) { $0 })

        lines.append("}")
        return lines.joined(separator: "\n")
    }

    /// `"key": [ … ]` with one rendered element per row. Formatting is irrelevant
    /// (CI diffs `jq -S` on both sides) — the keys and the values are the contract.
    private func jsonList<T>(_ key: String, _ rows: [T], trailingComma: Bool = true,
                             _ render: (T) -> String) -> String {
        let items = rows.map { "    " + render($0) }.joined(separator: ",\n")
        let inner = rows.isEmpty ? "" : "\n" + items + "\n  "
        return "  \"\(key)\": [\(inner)]\(trailingComma ? "," : "")"
    }

    /// ai_surfaces for the parity dump: every column emitted with SQLite's own
    /// type, because `sanctioned` holds TEXT behind an INTEGER declaration.
    private func aiSurfacesDump() -> [String] {
        var out: [String] = []
        run("""
            SELECT surface_key, kind, name, path, sanctioned, version, first_seen, last_seen
            FROM ai_surfaces ORDER BY surface_key LIMIT 50
            """) { row in
            out.append("{\"surface_key\": \(jcol(row, 0)), \"kind\": \(jcol(row, 1)), \"name\": \(jcol(row, 2)), \"path\": \(jcol(row, 3)), \"sanctioned\": \(jcol(row, 4)), \"version\": \(jcol(row, 5)), \"first_seen\": \(jcol(row, 6)), \"last_seen\": \(jcol(row, 7))}")
        }
        return out
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
}
