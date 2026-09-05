/**
 * Thin compatibility layer over node:sqlite (stdlib since Node 22, no native build
 * step) covering just the subset of better-sqlite3's API this codebase used —
 * .pragma() and .transaction() have no equivalent in node:sqlite, so they're shimmed
 * here; everything else (.exec, .prepare, .close) is passed straight through.
 *
 * Native modules break across Node versions and architectures (an ABI mismatch bit
 * this project on a Node upgrade before); a stdlib module can't.
 */
import { DatabaseSync } from 'node:sqlite';

export interface DatabaseOptions {
  readonly?: boolean;
  /** better-sqlite3 had this as a separate flag; node:sqlite's readOnly already implies it. */
  fileMustExist?: boolean;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * Every call site here does `db.prepare(sql).all() as SomeRow[]`, relying on
 * better-sqlite3's `.all()`/`.get()` being typed as plain `unknown` so that cast is
 * always legal. node:sqlite's StatementSync types them as a specific
 * Record<string, SQLOutputValue> shape instead, which TS then refuses to cast
 * directly to an unrelated row type — so this interface re-widens them to `unknown`,
 * matching the contract every call site was actually written against.
 */
export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export class Database {
  private readonly db: DatabaseSync;

  constructor(path: string, opts: DatabaseOptions = {}) {
    this.db = new DatabaseSync(path, { readOnly: opts.readonly });
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** better-sqlite3's set-a-pragma shorthand — the only form this codebase used. */
  pragma(statement: string): void {
    this.db.exec(`PRAGMA ${statement}`);
  }

  prepare(sql: string): Statement {
    return this.db.prepare(sql) as unknown as Statement;
  }

  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    return (...args: Args) => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}
