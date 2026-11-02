import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

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
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]!);
    db.pragma(`user_version = ${i + 1}`);
  }
}
