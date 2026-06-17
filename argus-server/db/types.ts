// Shared domain types for Argus. DB row shapes mirror db/schema.ts.

export type ServiceTier = "gateway" | "frontend" | "backend" | "auth" | "database" | "cache";
export type ServiceStatus = "healthy" | "failing" | "unknown";

export interface ServiceRow {
  id: number;
  name: string;
  port: number;
  tier: ServiceTier;
  status: ServiceStatus;
  last_checked: string;
  recovered_at: string | null;
  created_at: string;
}

export type AlertSeverity = "warning" | "critical";
export type AlertStatus = "firing" | "resolved";

export interface AlertRow {
  id: number;
  service_id: number;
  severity: AlertSeverity;
  metric_name: string;
  metric_value: number;
  threshold: number;
  message: string;
  status: AlertStatus;
  fired_at: string;
  resolved_at: string | null;
  created_at: string;
}

/** An alert joined with its service name/tier (the shape most queries return). */
export interface AlertWithService extends AlertRow {
  service_name: string;
  service_tier: ServiceTier;
}

export type IncidentStatus = "open" | "investigating" | "mitigated" | "resolved";

export interface IncidentRow {
  id: number;
  title: string;
  description: string | null;
  severity: AlertSeverity;
  likely_cause: string | null;
  rca: string | null;
  root_cause_service_id: number | null;
  status: IncidentStatus;
  runbook_used: string | null;
  created_at: string;
  updated_at: string;
}

export type ConfirmationStatus = "pending" | "approved" | "declined";

export interface ConfirmationRow {
  id: number;
  incident_id: number;
  action: string;
  requested_by: string | null;
  status: ConfirmationStatus;
  resolved_at: string | null;
  confirmed_at: string;
  created_at: string;
}

export interface DeploymentRow {
  id: number;
  service_id: number;
  version: string;
  commit_sha: string | null;
  deployed_by: string | null;
  deployed_at: string;
  created_at: string;
  service_name?: string;
}

export interface NotificationRow {
  id: number;
  incident_id: number;
  channel: string;
  message: string;
  sent_at: string;
  created_at: string;
  incident_title?: string;
}

export type MessageRole = "user" | "agent" | "system";

export interface MessageRow {
  id: number;
  thread_key: string;
  role: MessageRole;
  content: string;
  label: string | null;
  auto: number;
  created_at: string;
}

/** One chat message as returned to the client by GET /api/chat. */
export interface ChatMessage {
  role: MessageRole;
  content: string;
  label: string | null;
  auto: boolean;
  created_at: string;
}

export type WorkflowStep =
  | "detected"
  | "investigating"
  | "root_cause"
  | "remediation"
  | "confirmation"
  | "executing"
  | "verifying"
  | "resolved";

export interface Workflow {
  id: string;
  kind: "incident" | "pending";
  service_name: string;
  service_tier: string;
  service_status: string;
  step: WorkflowStep;
  firing_alerts: AlertWithService[];
  resolved_alerts: AlertWithService[];
  incident: IncidentRow | null;
  confirmations: ConfirmationRow[];
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A unit of work for the headless agent queue. */
export interface AgentTask {
  workflowId: string | null;
  prompt: string;
  label?: string;
  synthetic: boolean;
  dedupeKey?: string;
}
