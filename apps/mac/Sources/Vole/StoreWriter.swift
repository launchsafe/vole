import Foundation
import SQLite3

// MARK: - The reader side's two audit writes (tiers 3-4)
//
// DB.swift is deliberately read-only ("the TS collector owns writes"). Two
// specs nevertheless put a write obligation on THIS app, not the collector:
// the tier-3 egress ledger (every network attempt — denied ones included —
// lands in network_calls) and the tier-4 just-in-time viewer's info incident
// (a human looking at evidence is an audited event). This file is exactly
// those two inserts and nothing else: no schema, no migrations, no general
// write path — the collector keeps owning everything else.

enum StoreWriter {
    enum Bind {
        case text(String)
        case int(Int)
        case null
    }

    /// The store path, resolved exactly the way DB.swift resolves it.
    private static let storePath: String = {
        if let override = ProcessInfo.processInfo.environment["VOLE_DB"], !override.isEmpty {
            return override
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vole/vole.db").path
    }()

    /// SQLITE_TRANSIENT is not exposed by the SQLite module map — the standard shim.
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// Runs one statement against the store, best-effort: a missing store
    /// (fresh install, collector never ran) is skipped, never created here,
    /// and a failed write never surfaces — accounting, not a gate (the
    /// fail-open half of the egress.ts contract).
    private static func execute(_ sql: String, _ binds: [Bind]) {
        var h: OpaquePointer?
        guard sqlite3_open_v2(storePath, &h, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK,
              let h else { return }
        defer { sqlite3_close_v2(h) }
        sqlite3_busy_timeout(h, 2000)
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(h, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { return }
        defer { sqlite3_finalize(stmt) }
        for (i, b) in binds.enumerated() {
            switch b {
            case .text(let v): sqlite3_bind_text(stmt, Int32(i + 1), v, -1, transient)
            case .int(let v): sqlite3_bind_int64(stmt, Int32(i + 1), Int64(v))
            case .null: sqlite3_bind_null(stmt, Int32(i + 1))
            }
        }
        sqlite3_step(stmt)
    }

    /// The network_calls ledger row (migration 25's shape, written by the
    /// egress choke point in UpdateChecker.swift for EVERY attempt).
    static func recordNetworkCall(caller: String, destination: String, purpose: String) {
        execute(
            "INSERT INTO network_calls (caller, destination, purpose, ts) VALUES (?, ?, ?, ?)",
            [.text(caller), .text(destination), .text(purpose),
             .int(Int(Date().timeIntervalSince1970 * 1000))])
    }

    /// The tier-4 #25 contract: opening just-in-time evidence writes an
    /// info-severity incident naming the viewer and the fingerprint — the
    /// audit trail is the price of the capability. One row per open, so the
    /// key carries a random (not time-derived) discriminator.
    static func recordViewerIncident(fingerprint: String, detector: String,
                                     path: String, offset: Int, length: Int) {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        execute(
            """
            INSERT INTO anomalies (anomaly_key, rule, severity, tool, session_id, model,
                                   window_start, window_end, title, detail,
                                   observed, baseline, threshold, confidence, source, detected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [.text("jit_evidence_viewed:\(fingerprint):\(UUID().uuidString)"),
             .text("jit_evidence_viewed"), .text("info"), .text("vole"), .null, .null,
             .int(now), .int(now),
             .text("Just-in-time evidence viewed: \(detector)"),
             .text("The just-in-time evidence viewer re-read the matched \(detector) span "
                 + "at \(path.redactedHome) (offset \(offset), length \(length)) and rendered it "
                 + "redacted as [\(detector)]. Fingerprint \(fingerprint). "
                 + "The value is never stored, cached or exported."),
             .int(1), .null, .null, .text("exact"), .text("live"), .int(now)])
    }
}

private extension String {
    /// The collector's own incident detail convention: ~ for /Users/<who>,
    /// so a path in an incident row never names the account.
    var redactedHome: String {
        replacingOccurrences(of: "^/Users/[^/]+", with: "~", options: .regularExpression)
    }
}
