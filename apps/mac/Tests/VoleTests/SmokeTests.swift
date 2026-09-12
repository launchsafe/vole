import XCTest
import SQLite3
@testable import Vole

/// Regression tests for the app-side bugs that were only ever found by running the app.
///
/// The app had no tests at all and CI only compiled it, so a 55-second freeze, a corrupt
/// store reported as healthy, and a schema constant that blanked every panel all shipped
/// and were caught by hand. Each of those is pinned here.
final class StoreOpeningTests: XCTestCase {
    /// A store with the given rows, written the way the collector would.
    private func makeStore(_ setup: (OpaquePointer) -> Void = { _ in }) -> String {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("vole-test-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("vole.db").path

        var h: OpaquePointer?
        XCTAssertEqual(sqlite3_open(path, &h), SQLITE_OK)
        defer { sqlite3_close_v2(h) }
        sqlite3_exec(h, """
            CREATE TABLE usage_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE, tool TEXT NOT NULL,
              model TEXT, session_id TEXT, project TEXT, git_branch TEXT, ts INTEGER NOT NULL,
              input_tokens INTEGER, output_tokens INTEGER, cache_write_5m_tokens INTEGER,
              cache_write_1h_tokens INTEGER, cache_read_tokens INTEGER, reasoning_tokens INTEGER,
              total_tokens INTEGER, cost_usd REAL, confidence TEXT NOT NULL,
              estimation_method TEXT, is_error INTEGER NOT NULL DEFAULT 0, stop_reason TEXT,
              source TEXT NOT NULL DEFAULT 'live', raw_ref TEXT, user TEXT, machine TEXT,
              tools TEXT, agent_id TEXT, context_window INTEGER, duration_ms INTEGER,
              duration_kind TEXT);
            CREATE TABLE anomalies (
              id INTEGER PRIMARY KEY AUTOINCREMENT, anomaly_key TEXT UNIQUE, rule TEXT NOT NULL,
              severity TEXT NOT NULL, tool TEXT NOT NULL, session_id TEXT, model TEXT,
              window_start INTEGER, window_end INTEGER, title TEXT, detail TEXT,
              observed REAL NOT NULL, baseline REAL, threshold REAL, confidence TEXT NOT NULL,
              source TEXT NOT NULL DEFAULT 'live', detected_at INTEGER NOT NULL);
            """, nil, nil, nil)
        setup(h!)
        return path
    }

    private func insert(_ h: OpaquePointer, key: String, ts: Int, tokens: Int) {
        let sql = """
            INSERT INTO usage_events (event_key, tool, model, session_id, ts, total_tokens,
              input_tokens, output_tokens, cost_usd, confidence, source)
            VALUES ('\(key)', 'claude_code', 'claude-opus-5', 's', \(ts), \(tokens),
              \(tokens), 0, 1.0, 'exact', 'live');
            """
        sqlite3_exec(h, sql, nil, nil, nil)
    }

    /// Runs a block with VOLE_DB pointed somewhere, then restores it.
    private func withStore<T>(_ path: String, _ body: () async throws -> T) async rethrows -> T {
        let prev = ProcessInfo.processInfo.environment["VOLE_DB"]
        setenv("VOLE_DB", path, 1)
        defer { if let prev { setenv("VOLE_DB", prev, 1) } else { unsetenv("VOLE_DB") } }
        return try await body()
    }

    // MARK: - opening

    func testGarbageFileIsNotReportedAsAHealthyStore() async {
        // 8KB of noise used to open "successfully" and report `db: ok`, because
        // sqlite3_open_v2 never reads the file — the failure only surfaced later as an
        // empty dashboard, which reads as "no usage yet" rather than "unreadable".
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("vole-garbage-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("vole.db").path
        FileManager.default.createFile(
            atPath: path, contents: Data((0..<8192).map { _ in UInt8.random(in: 0...255) }))

        await withStore(path) {
            let db = DB()
            let opened = await db.opened
            XCTAssertFalse(opened, "a file that is not a database must not report as open")
        }
    }

    func testAMissingStoreIsNotOpen() async {
        await withStore("/nonexistent/definitely/not/here.db") {
            let db = DB()
            let opened = await db.opened
            XCTAssertFalse(opened)
        }
    }

    func testARealStoreOpensAndReads() async {
        let path = makeStore { h in
            self.insert(h, key: "a", ts: Int(Date().timeIntervalSince1970 * 1000), tokens: 100)
        }
        await withStore(path) {
            let db = DB()
            let opened = await db.opened
            XCTAssertTrue(opened)
            let rows = await db.breakdown(.all)
            XCTAssertFalse(rows.isEmpty, "a store with rows must read back")
        }
    }

    // MARK: - the freeze

    func testAFutureTimestampDoesNotExplodeTheTimeline() async {
        // A tool with a broken clock writing year 3999 made the zero-fill run to the
        // largest timestamp in the DATA: ~17M hourly buckets, one allocation each, a
        // ~55-second freeze on a view that refreshes every few seconds.
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let path = makeStore { h in
            self.insert(h, key: "now", ts: now, tokens: 100)
            self.insert(h, key: "future", ts: 64_060_588_799_000, tokens: 100) // 3999-12-31
        }

        await withStore(path) {
            let db = DB()
            let started = Date()
            let points = await db.timeseries(.h24)
            let elapsed = Date().timeIntervalSince(started)

            XCTAssertLessThan(elapsed, 2.0, "zero-fill is unbounded again — it took \(elapsed)s")
            XCTAssertLessThan(points.count, 20_000, "produced \(points.count) buckets")
            XCTAssertFalse(points.isEmpty, "the present-day row is still charted")
        }
    }

    func testAnEmptyStoreChartsNothingRatherThanHanging() async {
        let path = makeStore()
        await withStore(path) {
            let db = DB()
            let points = await db.timeseries(.h24)
            XCTAssertTrue(points.isEmpty)
        }
    }

    // MARK: - the schema gate

    func testKnownSchemaVersionIsSet() {
        // The gate silently blanked every panel when this drifted behind the
        // collector's newest migration: the app greeted a store its own embedded
        // collector had just written with "written by a newer Vole".
        // The collector-side test in packages/core asserts the two agree; this one
        // only guards against the constant being removed or zeroed.
        XCTAssertGreaterThan(DB.knownSchemaVersion, 0)
    }

    func testASchemaVersionIsReadBackFromTheStore() async {
        let path = makeStore { h in
            sqlite3_exec(h, "PRAGMA user_version = 7", nil, nil, nil)
        }
        await withStore(path) {
            let db = DB()
            let v = await db.schemaVersion()
            XCTAssertEqual(v, 7)
        }
    }
}
