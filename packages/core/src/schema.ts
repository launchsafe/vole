/**
 * Schema is an inlined string rather than a .sql asset so that bundlers (Next.js) can
 * resolve it without a runtime file read.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key             TEXT    NOT NULL UNIQUE,
  tool                  TEXT    NOT NULL,
  model                 TEXT,
  session_id            TEXT,
  project               TEXT,
  git_branch            TEXT,
  ts                    INTEGER NOT NULL,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER,
  cache_read_tokens     INTEGER,
  reasoning_tokens      INTEGER,
  total_tokens          INTEGER,
  cost_usd              REAL,
  confidence            TEXT    NOT NULL,
  is_error              INTEGER NOT NULL DEFAULT 0,
  stop_reason           TEXT,
  source                TEXT    NOT NULL DEFAULT 'live',
  raw_ref               TEXT,
  user                  TEXT,
  machine               TEXT,
  tools                 TEXT,
  agent_id              TEXT,
  context_window        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ue_ts      ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_ue_tool_ts ON usage_events(tool, ts);
CREATE INDEX IF NOT EXISTS idx_ue_session ON usage_events(session_id, ts);
-- (source, ts): every read filters source='live' AND ts>=?, so the composite lets
-- SQLite seek the partition then range-scan instead of scanning all live rows.
DROP INDEX IF EXISTS idx_ue_source;
CREATE INDEX IF NOT EXISTS idx_ue_source_ts ON usage_events(source, ts);

CREATE TABLE IF NOT EXISTS anomalies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  anomaly_key  TEXT    NOT NULL UNIQUE,
  rule         TEXT    NOT NULL,
  severity     TEXT    NOT NULL,
  tool         TEXT    NOT NULL,
  session_id   TEXT,
  model        TEXT,
  window_start INTEGER NOT NULL,
  window_end   INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  detail       TEXT    NOT NULL,
  observed     REAL    NOT NULL,
  baseline     REAL,
  threshold    REAL,
  confidence   TEXT    NOT NULL,
  source       TEXT    NOT NULL DEFAULT 'live',
  detected_at  INTEGER NOT NULL,
  user         TEXT,
  machine      TEXT
);
CREATE INDEX IF NOT EXISTS idx_an_detected ON anomalies(detected_at);
CREATE INDEX IF NOT EXISTS idx_an_source   ON anomalies(source);

CREATE TABLE IF NOT EXISTS collector_state (
  source_path     TEXT PRIMARY KEY,
  tool            TEXT    NOT NULL,
  last_offset     INTEGER NOT NULL DEFAULT 0,
  last_mtime      INTEGER,
  last_scanned_at INTEGER
);
`;
