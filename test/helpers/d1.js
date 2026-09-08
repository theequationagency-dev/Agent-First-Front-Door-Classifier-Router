/**
 * A D1-shaped database backed by node:sqlite, for tests.
 *
 * D1 is SQLite with a thin async API, so the real schema, the real SQL and
 * the real row shapes all run here — the only thing being faked is the
 * transport. That means these tests catch broken SQL, not just broken
 * JavaScript. Anything the code calls on `env.DB` is implemented below;
 * anything it doesn't call is deliberately absent so a new dependency on the
 * D1 API shows up as a test failure rather than silently passing.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

const num = (v) => (typeof v === "bigint" ? Number(v) : v);
const plain = (row) => (row == null ? row : { ...row });

class FakeStatement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new FakeStatement(this.db, this.sql, params);
  }

  async all() {
    const results = this.db.prepare(this.sql).all(...this.params).map(plain);
    return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
  }

  async first(column) {
    const row = plain(this.db.prepare(this.sql).get(...this.params));
    if (row === undefined || row === null) return null;
    return column === undefined ? row : row[column];
  }

  async run() {
    return { success: true, meta: this._run() };
  }

  /** Shared by run() and batch(): executes and returns D1-shaped meta. */
  _run() {
    const stmt = this.db.prepare(this.sql);
    // A statement that returns rows (INSERT … RETURNING, SELECT) must be
    // stepped with all(); run() throws on those in node:sqlite.
    if (/^\s*select/i.test(this.sql)) {
      stmt.all(...this.params);
      return { changes: 0, last_row_id: 0 };
    }
    const info = stmt.run(...this.params);
    return { changes: num(info.changes), last_row_id: num(info.lastInsertRowid) };
  }
}

class FakeD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(sql) {
    return new FakeStatement(this.sqlite, sql);
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** D1 runs a batch as one transaction; so do we. */
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const out = statements.map((s) => {
        if (/^\s*select/i.test(s.sql)) {
          return { results: s.db.prepare(s.sql).all(...s.params).map(plain), success: true, meta: { changes: 0, last_row_id: 0 } };
        }
        return { results: [], success: true, meta: s._run() };
      });
      this.sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

/**
 * Fresh in-memory database with migrations/0001_init.sql applied.
 * Pass { seed: true } to also load seed.sql.
 */
export function createTestDb({ seed = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(readFileSync(repoFile("migrations/0001_init.sql"), "utf8"));
  if (seed) sqlite.exec(readFileSync(repoFile("seed.sql"), "utf8"));
  return { DB: new FakeD1(sqlite), sqlite };
}

/** A Worker env with the D1 binding and sensible test vars. */
export function createTestEnv(overrides = {}) {
  const { DB, sqlite } = createTestDb({ seed: overrides.seed ?? true });
  delete overrides.seed;
  return {
    env: {
      DB,
      ORIGIN_URL: "https://origin.example.net",
      ADMIN_TOKEN: "test-admin-token",
      ...overrides,
    },
    sqlite,
  };
}

/** A ctx whose waitUntil work can be awaited, so logging assertions are stable. */
export function createTestCtx() {
  const pending = [];
  return {
    ctx: { waitUntil: (p) => pending.push(Promise.resolve(p)) },
    settled: () => Promise.all(pending),
  };
}

/** Reads rows straight out of the underlying sqlite handle, for assertions. */
export function rows(sqlite, sql, ...params) {
  return sqlite.prepare(sql).all(...params).map(plain);
}
