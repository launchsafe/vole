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

// MARK: - Database  (read-only; the TS collector owns writes)

final class DB {
    /// The newest store schema this app understands. Must move in lockstep with the
    /// collector's MIGRATIONS head (packages/core/src/db.ts) — the version gate
    /// depends on the two agreeing about what "current" means.
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
        // sqlite3_open_v2 allocates a connection object even when it FAILS, and it
        // must be closed or it leaks. This runs on every poll while the store is
        // missing (a fresh install waiting for its first collector pass), so a
        // dropped handle here leaked one connection every few seconds, forever.
        func attempt(_ flags: Int32) -> OpaquePointer? {
            var h: OpaquePointer?
            if sqlite3_open_v2(path, &h, flags, nil) == SQLITE_OK { return h }
            if let h { sqlite3_close_v2(h) }
            return nil
        }
        // WAL databases sometimes refuse a pure READONLY connection; the file is
        // user-writable, so fall back rather than show nothing.
        handle = attempt(SQLITE_OPEN_READONLY) ?? attempt(SQLITE_OPEN_READWRITE)
        opened = handle != nil
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

    /// The full capability set, for the nav shell's probe.
    func tableNames() -> Set<String> {
        var out: Set<String> = []
        run("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')") { row in
            if let n = colText(row, 0) { out.insert(n) }
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

    /// The migration ledger — the upgrade boundary: a row with no applied_at
    /// predates the ledger itself and must render as 'unknown', never a date.
    /// Epoch-ms of the collector's most recent scan cycle (it stamps every source it
    /// touches, every pass). nil if the collector has never run against this database.
    func collectorLastSeen() -> Int? {
        var out: Int?
        run("SELECT MAX(last_scanned_at) FROM collector_state") { out = colIntOpt($0, 0) }
        return out
    }

    /// One heartbeat per collector — its latest pass, written even when the pass found
    /// nothing. `collector_state` above is per-FILE and only Claude Code writes it, so
    /// a Codex- or OpenCode-only Mac used to read as "Setting up…" forever.
    func collectorHeartbeats() -> [CollectorHeartbeat] {        var out: [CollectorHeartbeat] = []
        run("""
            SELECT cr.tool, cr.started_at, cr.duration_ms, cr.files, cr.parsed,
                   cr.inserted, cr.source_state, cr.ok
            FROM collector_runs cr
            JOIN (SELECT tool, MAX(started_at) AS latest FROM collector_runs GROUP BY tool) t
              ON t.tool = cr.tool AND t.latest = cr.started_at
            ORDER BY cr.tool
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
