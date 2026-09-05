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
    var id: String { tool }
}

struct Summary {
    var calls = 0
    var tokens = 0
    var cost: Double? = nil
    var sessions = 0
    var errors = 0
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

struct Incident: Identifiable {
    let id: Int
    let rule: String
    let severity: String
    let tool: String
    let sessionID: String?
    let model: String?
    let windowStart: Int
    let windowEnd: Int
    let title: String
    let detail: String
    let confidence: String
    let source: String

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
                   COALESCE(SUM(CASE WHEN \(tf) THEN cache_read_tokens END), 0),
                   COALESCE(SUM(CASE WHEN \(tf) THEN COALESCE(input_tokens,0)
                        + COALESCE(cache_write_5m_tokens,0) + COALESCE(cache_write_1h_tokens,0) END), 0)
            FROM usage_events WHERE ts >= ? AND source = 'live'
            """, [from]) { row in
            s.calls = colInt(row, 0); s.tokens = colInt(row, 1); s.cost = colDblOpt(row, 2)
            s.sessions = colInt(row, 3); s.errors = colInt(row, 4)
            cacheRead = colInt(row, 5); freshIn = colInt(row, 6)
        }

        run("""
            SELECT tool, COUNT(*),
                   CASE WHEN SUM(CASE WHEN \(tf) THEN 1 ELSE 0 END) = 0 THEN NULL
                        ELSE COALESCE(SUM(CASE WHEN \(tf) THEN total_tokens END), 0) END,
                   SUM(cost_usd), MIN(confidence)
            FROM usage_events WHERE ts >= ? AND source = 'live'
            GROUP BY tool ORDER BY COUNT(*) DESC
            """, [from]) { row in
            s.byTool.append(ToolSummary(
                tool: colText(row, 0) ?? "?", calls: colInt(row, 1),
                tokens: colIntOpt(row, 2), cost: colDblOpt(row, 3),
                confidence: colText(row, 4) ?? "exact"))
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
        return map.values.sorted { $0.bucket < $1.bucket }
    }

    func anomalies(_ r: DateRange, limit: Int = 100) -> [Incident] {
        let from = r.startMs()
        var out: [Incident] = []
        run("""
            SELECT id, rule, severity, tool, session_id, model, window_start, window_end,
                   title, detail, confidence, source
            FROM anomalies WHERE window_end >= ? AND source = 'live'
            ORDER BY window_start DESC LIMIT ?
            """, [from, limit]) { row in
            out.append(Incident(
                id: colInt(row, 0), rule: colText(row, 1) ?? "", severity: colText(row, 2) ?? "info",
                tool: colText(row, 3) ?? "?", sessionID: colText(row, 4), model: colText(row, 5),
                windowStart: colInt(row, 6), windowEnd: colInt(row, 7),
                title: colText(row, 8) ?? "", detail: colText(row, 9) ?? "",
                confidence: colText(row, 10) ?? "exact", source: colText(row, 11) ?? "live"))
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
