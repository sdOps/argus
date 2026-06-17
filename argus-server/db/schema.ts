import { unlinkSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  port INTEGER NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('gateway', 'frontend', 'backend', 'auth', 'database', 'cache')),
  status TEXT NOT NULL DEFAULT 'healthy' CHECK(status IN ('healthy', 'failing', 'unknown')),
  last_checked TEXT DEFAULT (datetime('now')),
  recovered_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id),
  severity TEXT NOT NULL CHECK(severity IN ('warning', 'critical')),
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  threshold REAL NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'firing' CHECK(status IN ('firing', 'resolved')),
  fired_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL CHECK(severity IN ('warning', 'critical')),
  likely_cause TEXT,
  rca TEXT,
  root_cause_service_id INTEGER REFERENCES services(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'investigating', 'mitigated', 'resolved')),
  runbook_used TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incident_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  alert_id INTEGER NOT NULL REFERENCES alerts(id),
  correlated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(incident_id, alert_id)
);

CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id),
  version TEXT NOT NULL,
  commit_sha TEXT,
  deployed_by TEXT,
  deployed_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  channel TEXT NOT NULL,
  message TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  action TEXT NOT NULL,
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'declined')),
  resolved_at TEXT,
  confirmed_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'agent', 'system')),
  content TEXT NOT NULL,
  label TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS thread_aliases (
  alias TEXT PRIMARY KEY,
  canonical TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_service ON alerts(service_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_key);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at);
CREATE INDEX IF NOT EXISTS idx_deployments_service ON deployments(service_id);
CREATE INDEX IF NOT EXISTS idx_deployments_deployed ON deployments(deployed_at);
`;

function migrate(db: Database) {
  const cols = db.query("PRAGMA table_info(confirmations)").all() as { name: string }[];
  const names = new Set(cols.map(c => c.name));
  if (!names.has("status")) {
    db.exec("ALTER TABLE confirmations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!names.has("resolved_at")) {
    db.exec("ALTER TABLE confirmations ADD COLUMN resolved_at TEXT");
  }

  // incidents.rca — root-cause analysis written after resolution
  const incCols = new Set((db.query("PRAGMA table_info(incidents)").all() as { name: string }[]).map(c => c.name));
  if (!incCols.has("rca")) {
    db.exec("ALTER TABLE incidents ADD COLUMN rca TEXT");
  }

  // services.recovered_at — timestamp the agent last recovered the service (post-recovery
  // cooldown; the scraper suppresses new alerts for a short window after it).
  const svcCols = new Set((db.query("PRAGMA table_info(services)").all() as { name: string }[]).map(c => c.name));
  if (!svcCols.has("recovered_at")) {
    db.exec("ALTER TABLE services ADD COLUMN recovered_at TEXT");
  }
}

export function initDb(dbPath: string): Database {
  // Remove leftover WAL/SHM files that can leave DB in a bad state
  for (const suffix of ["-wal", "-shm"]) {
    const path = dbPath + suffix;
    if (existsSync(path)) {
      try { unlinkSync(path); } catch { /* ignore */ }
    }
  }

  try {
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(SCHEMA_SQL);
    migrate(db);
    // Quick sanity check
    db.query("SELECT COUNT(*) AS cnt FROM services").get();
    return db;
  } catch (e) {
    // Database appears corrupt — nuke and recreate
    for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(SCHEMA_SQL);
    return db;
  }
}