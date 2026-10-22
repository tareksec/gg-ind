import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = path.resolve(process.env.DB_PATH || './data/smart-indexer.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS service_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name       TEXT    NOT NULL UNIQUE,
    client_email    TEXT    NOT NULL DEFAULT '',
    project_id      TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL DEFAULT 'active',  -- active | disabled | invalid | missing
    usage_date      TEXT,                               -- quota day (Pacific time) that used_today belongs to
    used_today      INTEGER NOT NULL DEFAULT 0,
    exhausted_date  TEXT,                               -- quota day on which Google answered 429 for this project
    total_used      INTEGER NOT NULL DEFAULT 0,
    last_used_at    TEXT,
    last_error      TEXT,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id         TEXT    NOT NULL,
    url              TEXT    NOT NULL,                  -- the URL the user wants indexed
    mode             TEXT    NOT NULL,                  -- DIRECT | BRIDGE
    action           TEXT    NOT NULL,                  -- URL_UPDATED | URL_DELETED
    strategy         TEXT,                              -- 301_REDIRECT | HTML_BRIDGE (BRIDGE mode only)
    slug             TEXT,
    bridge_url       TEXT,
    status           TEXT    NOT NULL DEFAULT 'pending', -- pending | processing | success | failed | quota_exceeded
    service_account  TEXT,
    project_id       TEXT,
    http_status      INTEGER,
    message          TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    processed_at     TEXT,
    processed_day    TEXT                               -- quota day the request was sent to Google
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status, id);
  CREATE INDEX IF NOT EXISTS idx_submissions_day    ON submissions (processed_day, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_slug ON submissions (slug) WHERE slug IS NOT NULL;

  CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
`);

export const DEFAULT_SETTINGS = {
  bridge_base_url: '',
  worker_api_key: '',
  delay_ms: '1500',
  daily_limit: '200',
  default_mode: 'DIRECT',
  default_strategy: 'HTML_BRIDGE',
  default_action: 'URL_UPDATED',
};

const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertDefault.run(key, value);

export const nowIso = () => new Date().toISOString();

// Google resets Indexing API quotas at midnight Pacific time, so "today" is a Pacific calendar day.
const pacificDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export const quotaDay = (date = new Date()) => pacificDay.format(date);

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

export function saveSettings(values) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) upsert.run(key, String(value));
  })();
}
