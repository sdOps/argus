// Database API for Argus incident triage
// All queries go through this module — no raw SQL outside.

import type { Database } from "bun:sqlite";
import type {
  ServiceRow, ServiceStatus, AlertRow, AlertWithService, IncidentRow, IncidentStatus,
  ConfirmationRow, DeploymentRow, NotificationRow, MessageRow, MessageRole, AlertSeverity,
  AlertStatus, ChatMessage,
} from "./types.ts";
import { notifyAlertTransition } from "../notify.js";

// ── Services ──

export function listServices(db: Database): ServiceRow[] {
  return db.query("SELECT * FROM services ORDER BY tier, name").all() as ServiceRow[];
}

export function getService(db: Database, name: string): ServiceRow | null {
  return db.query("SELECT * FROM services WHERE name = ?").get(name) as ServiceRow | null;
}

export function updateServiceStatus(db: Database, { name, status }: { name: string; status: ServiceStatus }): ServiceRow | null {
  db.query("UPDATE services SET status = ?, last_checked = datetime('now') WHERE name = ?").run(status, name);
  return getService(db, name);
}

// ── Alerts ──

export interface CreateAlertInput {
  service_id: number;
  severity: AlertSeverity;
  metric_name: string;
  metric_value: number;
  threshold: number;
  message: string;
}

export function createAlert(db: Database, { service_id, severity, metric_name, metric_value, threshold, message }: CreateAlertInput): AlertRow {
  const result = db.query(
    `INSERT INTO alerts (service_id, severity, metric_name, metric_value, threshold, message, status)
     VALUES (?, ?, ?, ?, ?, ?, 'firing')`
  ).run(service_id, severity, metric_name, metric_value, threshold, message);
  const alert = db.query("SELECT * FROM alerts WHERE id = ?").get(Number(result.lastInsertRowid)) as AlertRow;
  // Deterministic reflex ping — fires for every firing transition regardless of ingestion
  // mode (built-in scraper or Alertmanager webhook both funnel through here).
  const svc = db.query("SELECT name FROM services WHERE id = ?").get(service_id) as { name: string } | null;
  if (svc) notifyAlertTransition({ type: "firing", service: svc.name, metric: metric_name });
  return alert;
}

export function listActiveAlerts(db: Database): AlertWithService[] {
  return db.query(
    `SELECT a.*, s.name AS service_name, s.tier AS service_tier
     FROM alerts a
     JOIN services s ON s.id = a.service_id
     WHERE a.status = 'firing'
     ORDER BY a.fired_at DESC`
  ).all() as AlertWithService[];
}

export function listAllAlerts(db: Database, { limit = 50 }: { limit?: number } = {}): AlertWithService[] {
  return db.query(
    `SELECT a.*, s.name AS service_name, s.tier AS service_tier
     FROM alerts a
     JOIN services s ON s.id = a.service_id
     ORDER BY a.fired_at DESC
     LIMIT ?`
  ).all(limit) as AlertWithService[];
}

export function resolveAlert(db: Database, alertId: number): AlertRow | null {
  // Only ping on a genuine firing→resolved transition (skip if already resolved).
  const before = db.query("SELECT status, metric_name, service_id FROM alerts WHERE id = ?")
    .get(alertId) as { status: AlertStatus; metric_name: string; service_id: number } | null;
  db.query("UPDATE alerts SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(alertId);
  if (before && before.status === "firing") {
    const svc = db.query("SELECT name FROM services WHERE id = ?").get(before.service_id) as { name: string } | null;
    if (svc) notifyAlertTransition({ type: "resolved", service: svc.name, metric: before.metric_name });
  }
  return db.query("SELECT * FROM alerts WHERE id = ?").get(alertId) as AlertRow | null;
}

// ── Post-recovery cooldown ──
// When the agent recovers a service (execute_runbook_step), we stamp services.recovered_at.
// The scraper consults this to suppress NEW alert creation for a short window so a metrics
// reading taken around the recovery boundary doesn't spawn a phantom "Detected" workflow.

export function markServiceRecovered(db: Database, serviceId: number): void {
  db.query("UPDATE services SET recovered_at = datetime('now') WHERE id = ?").run(serviceId);
}

/** True if the service was recovered within the last `windowSec` seconds. */
export function isServiceInCooldown(db: Database, serviceId: number, windowSec: number): boolean {
  const row = db.query(
    "SELECT (strftime('%s','now') - strftime('%s', recovered_at)) AS age FROM services WHERE id = ? AND recovered_at IS NOT NULL"
  ).get(serviceId) as { age: number | null } | null;
  return !!row && row.age !== null && row.age < windowSec;
}

// ── Incidents ──

export interface CreateIncidentInput {
  title: string;
  description?: string | null;
  severity: AlertSeverity;
  likely_cause?: string | null;
  root_cause_service_id?: number | null;
  runbook_used?: string | null;
}

export function createIncident(db: Database, { title, description, severity, likely_cause, root_cause_service_id, runbook_used }: CreateIncidentInput): IncidentRow {
  const result = db.query(
    `INSERT INTO incidents (title, description, severity, likely_cause, root_cause_service_id, runbook_used, status)
     VALUES (?, ?, ?, ?, ?, ?, 'open')`
  ).run(title, description || null, severity, likely_cause || null, root_cause_service_id || null, runbook_used || null);
  return db.query("SELECT * FROM incidents WHERE id = ?").get(Number(result.lastInsertRowid)) as IncidentRow;
}

export function getIncident(db: Database, incidentId: number): IncidentRow | null {
  return db.query("SELECT * FROM incidents WHERE id = ?").get(incidentId) as IncidentRow | null;
}

export interface UpdateIncidentInput {
  id: number;
  status?: IncidentStatus;
  description?: string;
  likely_cause?: string;
  rca?: string;
  root_cause_service_id?: number | null;
}

export function updateIncident(db: Database, { id, status, description, likely_cause, rca, root_cause_service_id }: UpdateIncidentInput): IncidentRow | null {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (status) { sets.push("status = ?"); values.push(status); }
  if (description !== undefined) { sets.push("description = ?"); values.push(description); }
  if (likely_cause !== undefined) { sets.push("likely_cause = ?"); values.push(likely_cause); }
  if (rca !== undefined) { sets.push("rca = ?"); values.push(rca); }
  if (root_cause_service_id !== undefined) { sets.push("root_cause_service_id = ?"); values.push(root_cause_service_id); }
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.query(`UPDATE incidents SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return db.query("SELECT * FROM incidents WHERE id = ?").get(id) as IncidentRow | null;
}

export function listIncidents(db: Database, { status, limit = 50 }: { status?: string | null; limit?: number } = {}): IncidentRow[] {
  if (status) {
    return db.query(
      "SELECT * FROM incidents WHERE status = ? ORDER BY created_at DESC LIMIT ?"
    ).all(status, limit) as IncidentRow[];
  }
  return db.query("SELECT * FROM incidents ORDER BY created_at DESC LIMIT ?").all(limit) as IncidentRow[];
}

// ── Incident-Alert correlation ──

export function correlateAlert(db: Database, { incident_id, alert_id }: { incident_id: number; alert_id: number }): void {
  db.query(
    "INSERT OR IGNORE INTO incident_alerts (incident_id, alert_id) VALUES (?, ?)"
  ).run(incident_id, alert_id);
}

export function getIncidentAlerts(db: Database, incident_id: number): AlertWithService[] {
  return db.query(
    `SELECT a.*, s.name AS service_name, s.tier AS service_tier
     FROM incident_alerts ia
     JOIN alerts a ON a.id = ia.alert_id
     JOIN services s ON s.id = a.service_id
     WHERE ia.incident_id = ?`
  ).all(incident_id) as AlertWithService[];
}

// ── Deployments ──

export function listRecentDeployments(db: Database, { hours = 24, limit = 20 }: { hours?: number; limit?: number } = {}): DeploymentRow[] {
  return db.query(
    `SELECT d.*, s.name AS service_name
     FROM deployments d
     JOIN services s ON s.id = d.service_id
     WHERE d.deployed_at >= datetime('now', ? || ' hours')
     ORDER BY d.deployed_at DESC
     LIMIT ?`
  ).all(-hours, limit) as DeploymentRow[];
}

export interface CreateDeploymentInput {
  service_id: number;
  version: string;
  commit_sha?: string | null;
  deployed_by?: string | null;
}

export function createDeployment(db: Database, { service_id, version, commit_sha, deployed_by }: CreateDeploymentInput): DeploymentRow {
  const result = db.query(
    `INSERT INTO deployments (service_id, version, commit_sha, deployed_by)
     VALUES (?, ?, ?, ?)`
  ).run(service_id, version, commit_sha || null, deployed_by || null);
  return db.query("SELECT * FROM deployments WHERE id = ?").get(Number(result.lastInsertRowid)) as DeploymentRow;
}

// ── Notifications ──

export function createNotification(db: Database, { incident_id, channel, message }: { incident_id: number; channel: string; message: string }): NotificationRow {
  const result = db.query(
    `INSERT INTO notifications (incident_id, channel, message)
     VALUES (?, ?, ?)`
  ).run(incident_id, channel, message);
  return db.query("SELECT * FROM notifications WHERE id = ?").get(Number(result.lastInsertRowid)) as NotificationRow;
}

export function listNotifications(db: Database, incident_id: number): NotificationRow[] {
  return db.query("SELECT * FROM notifications WHERE incident_id = ? ORDER BY sent_at DESC").all(incident_id) as NotificationRow[];
}

// ── Confirmations ──

export function createConfirmation(db: Database, { incident_id, action, requested_by }: { incident_id: number; action: string; requested_by?: string | null }): ConfirmationRow {
  const result = db.query(
    `INSERT INTO confirmations (incident_id, action, requested_by)
     VALUES (?, ?, ?)`
  ).run(incident_id, action, requested_by || null);
  return db.query("SELECT * FROM confirmations WHERE id = ?").get(Number(result.lastInsertRowid)) as ConfirmationRow;
}

export function listConfirmations(db: Database, incident_id: number): ConfirmationRow[] {
  return db.query("SELECT * FROM confirmations WHERE incident_id = ? ORDER BY created_at DESC").all(incident_id) as ConfirmationRow[];
}

// ── Chat messages (durable transcript) ──

export function insertMessage(db: Database, { thread_key, role, content, label = null, auto = 0 }: { thread_key: string; role: MessageRole; content: string; label?: string | null; auto?: number }): number {
  const result = db.query(
    `INSERT INTO messages (thread_key, role, content, label, auto)
     VALUES (?, ?, ?, ?, ?)`
  ).run(thread_key, role, content, label, auto ? 1 : 0);
  return Number(result.lastInsertRowid);
}

export function setThreadAlias(db: Database, alias: string, canonical: string): void {
  if (!alias || !canonical || alias === canonical) return;
  db.query("INSERT OR REPLACE INTO thread_aliases (alias, canonical) VALUES (?, ?)").run(alias, canonical);
}

// Returns { [canonicalThreadKey]: ChatMessage[] } in chronological order.
export function listChat(db: Database): Record<string, ChatMessage[]> {
  const aliasMap: Record<string, string> = Object.fromEntries(
    (db.query("SELECT alias, canonical FROM thread_aliases").all() as { alias: string; canonical: string }[])
      .map(a => [a.alias, a.canonical])
  );
  const rows = db.query(
    "SELECT thread_key, role, content, label, auto, created_at FROM messages ORDER BY id ASC"
  ).all() as MessageRow[];
  const threads: Record<string, ChatMessage[]> = {};
  for (const m of rows) {
    const key = aliasMap[m.thread_key] || m.thread_key;
    (threads[key] ||= []).push({
      role: m.role,
      content: m.content,
      label: m.label,
      auto: !!m.auto,
      created_at: m.created_at,
    });
  }
  return threads;
}

// Drop transcripts for incidents that are resolved/mitigated (called by clear-resolved).
export function deleteMessagesForClosedIncidents(db: Database): void {
  const closed = (db.query("SELECT id FROM incidents WHERE status IN ('resolved', 'mitigated')").all() as { id: number }[])
    .map(r => `inc-${r.id}`);
  if (!closed.length) return;
  const closedSet = new Set(closed);
  const keys = new Set(closed);
  for (const a of db.query("SELECT alias, canonical FROM thread_aliases").all() as { alias: string; canonical: string }[]) {
    if (closedSet.has(a.canonical)) keys.add(a.alias);
  }
  const list = [...keys];
  db.query(`DELETE FROM messages WHERE thread_key IN (${list.map(() => "?").join(",")})`).run(...list);
  db.query(`DELETE FROM thread_aliases WHERE canonical IN (${closed.map(() => "?").join(",")})`).run(...closed);
}
