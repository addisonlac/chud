import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Uses Node's built-in SQLite (node:sqlite) — no native module to compile,
 * so `npm install` works on any Windows/Mac/Linux machine without build
 * tools. This thin wrapper keeps a small, familiar API for the rest of the code.
 */
type Param = unknown;

function bind(params: Param[]): SQLInputValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p as SQLInputValue;
  });
}

export interface Statement {
  run(...params: Param[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: Param[]): unknown;
  all(...params: Param[]): unknown[];
}

export class DB {
  private readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
  }

  prepare(sql: string): Statement {
    const stmt = this.raw.prepare(sql);
    return {
      run: (...p) => {
        const r = stmt.run(...bind(p));
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
      // node:sqlite returns null-prototype rows; spread them into plain objects
      get: (...p) => {
        const row = stmt.get(...bind(p));
        return row ? { ...row } : undefined;
      },
      all: (...p) => stmt.all(...bind(p)).map((r) => ({ ...r })),
    };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Wraps fn in a transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): () => T {
    return () => {
      if (this.depth > 0) return fn();
      this.depth++;
      this.raw.exec("BEGIN");
      try {
        const out = fn();
        this.raw.exec("COMMIT");
        return out;
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      } finally {
        this.depth--;
      }
    };
  }

  close(): void {
    this.raw.close();
  }
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS leads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    domain        TEXT UNIQUE,
    page_id       TEXT UNIQUE,
    name          TEXT NOT NULL,
    source        TEXT NOT NULL,
    niche         TEXT,
    website_url   TEXT,
    facebook_url  TEXT,
    platform      TEXT,
    status        TEXT NOT NULL DEFAULT 'new',
    category      TEXT,
    scores        TEXT,
    email         TEXT,
    contact_name  TEXT,
    socials       TEXT,
    ad_data       TEXT,
    findings      TEXT,
    error         TEXT,
    replied_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_category ON leads(category);

  CREATE TABLE IF NOT EXISTS drafts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    step        INTEGER NOT NULL DEFAULT 0,
    channel     TEXT NOT NULL DEFAULT 'email',
    subject     TEXT NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    composer    TEXT NOT NULL DEFAULT 'template',
    delay_days  INTEGER NOT NULL DEFAULT 0,
    send_after  TEXT,
    sent_at     TEXT,
    message_id  TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(lead_id, step)
  );
  CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);

  CREATE TABLE IF NOT EXISTS suppression (
    email       TEXT PRIMARY KEY,
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL DEFAULT (datetime('now')),
    level   TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL
  );
  `,
];

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DB(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
  }
}
