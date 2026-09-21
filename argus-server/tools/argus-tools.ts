import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Database } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "./yaml-mini.js";
import { serviceBaseUrl } from "../service-url.js";
import type { AlertSeverity, IncidentStatus, ServiceStatus, ConfirmationRow, ServiceRow } from "../db/types.ts";
import {
  listServices,
  getService,
  updateServiceStatus,
  listActiveAlerts,
  listAllAlerts,
  createIncident,
  getIncident,
  updateIncident,
  listIncidents,
  correlateAlert,
  getIncidentAlerts,
  listRecentDeployments,
  createNotification,
  createConfirmation,
  markServiceRecovered,
  getIncidentRemediationAttempts,
  incrementIncidentRemediationAttempts,
} from "../db/api.js";

let db!: Database;
const RUNBOOKS_DIR = resolve(import.meta.dir, "../../runbooks/services");

export function initArgusTools(database: Database): void {
  db = database;
}

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: {},
  };
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { isError: true },
  };
}

// ── Alert Tools ──

const getAlertTool = defineTool({
  name: "get_alert",
  label: "Get Alert Details",
  description: `Get details of a specific alert by ID. Use this when you receive an alert notification and need to understand what fired — which service, which metric, what value, and what threshold was crossed.`,
  parameters: Type.Object({
    alert_id: Type.Number({ description: "The alert ID to look up" }),
  }),
  execute: async (_id, params) => {
    try {
      const alert = db.query(
        `SELECT a.*, s.name AS service_name, s.tier AS service_tier
         FROM alerts a JOIN services s ON s.id = a.service_id WHERE a.id = ?`
      ).get(params.alert_id);
      if (!alert) return toolResult({ error: `Alert ${params.alert_id} not found` });
      return toolResult(alert);
    } catch (err) { return toolError(err); }
  },
});

const listActiveAlertsTool = defineTool({
  name: "list_active_alerts",
  label: "List Active Alerts",
  description: `List all currently firing alerts across all six services. Use this to check for correlated alerts — if multiple services are alerting, look for foundational services (pgsql, redis) as the likely root cause before assuming independent failures.`,
  parameters: Type.Object({}),
  execute: async () => {
    try {
      const alerts = listActiveAlerts(db);
      if (alerts.length === 0) {
        return toolResult({ message: "No active alerts. All services are healthy.", services: listServices(db).map(s => `${s.name} (${s.tier}): ${s.status}`) });
      }
      return toolResult({ active_alerts: alerts, count: alerts.length });
    } catch (err) { return toolError(err); }
  },
});

const listAllAlertsTool = defineTool({
  name: "list_all_alerts",
  label: "List All Alerts",
  description: `List all alerts (both firing and resolved), optionally limited to a recent count. Use this during RCA when you need to see what fired and when it resolved — the active-alerts tool only shows currently firing alerts.`,
  parameters: Type.Object({
    limit: Type.Optional(Type.Number({ description: "Maximum number of alerts to return (default 50)" })),
  }),
  execute: async (_id, params) => {
    try {
      const alerts = listAllAlerts(db, { limit: params.limit || 50 });
      return toolResult({ alerts, count: alerts.length });
    } catch (err) { return toolError(err); }
  },
});

// ── Service Tools ──

const checkServiceHealthTool = defineTool({
  name: "check_service_health",
  label: "Check Service Health",
  description: `Check the current health and metrics of a specific service by scraping its /metrics endpoint. Returns both the service status from the database and live metrics from the service. Use this to investigate a specific service during triage.`,
  parameters: Type.Object({
    service: Type.String({ description: "Service name: gateway, app-ui, app-api, auth, pgsql, or redis" }),
  }),
  execute: async (_id, params) => {
    try {
      const svc = getService(db, params.service);
      if (!svc) return toolResult({ error: `Service "${params.service}" not found. Valid services: gateway, app-ui, app-api, auth, pgsql, redis` });

      let liveMetrics = null;
      let liveStatus = "unknown";
      try {
        const resp = await fetch(`${serviceBaseUrl(svc)}/metrics`);
        if (resp.ok) {
          const text = await resp.text();
          liveMetrics = parsePrometheusMetrics(text);
          // Determine live status from metrics
          liveStatus = determineServiceStatus(params.service, liveMetrics);
          // Update DB status
          updateServiceStatus(db, { name: params.service, status: liveStatus as ServiceStatus });
        } else {
          liveStatus = "unreachable";
        }
      } catch {
        liveStatus = "unreachable";
      }

      return toolResult({
        service: svc.name,
        tier: svc.tier,
        db_status: svc.status,
        live_status: liveStatus,
        port: svc.port,
        metrics: liveMetrics,
      });
    } catch (err) { return toolError(err); }
  },
});

// ── Incident Tools ──

const createIncidentTool = defineTool({
  name: "create_incident",
  label: "Create Incident",
  description: `Create a new incident record with your triage findings. Include a descriptive title, the likely root cause, severity, and any runbook used. Correlate this with active alerts if applicable.`,
  parameters: Type.Object({
    title: Type.String({ description: "Incident title, e.g. 'Database failure cascade — pgsql connection errors'" }),
    description: Type.String({ description: "Detailed description of the incident and your analysis" }),
    severity: Type.String({ description: "Severity: warning or critical" }),
    likely_cause: Type.Optional(Type.String({ description: "Your assessment of the likely root cause" })),
    root_cause_service: Type.Optional(Type.String({ description: "Name of the root cause service: gateway, app-ui, app-api, auth, pgsql, or redis" })),
    runbook_used: Type.Optional(Type.String({ description: "Which runbook was referenced, e.g. 'pgsql'" })),
    correlate_alert_ids: Type.Optional(Type.Array(Type.Number(), { description: "Alert IDs to correlate with this incident" })),
  }),
  executionMode: "sequential",
  execute: async (_id, params) => {
    try {
      let rootCauseServiceId = null;
      if (params.root_cause_service) {
        const svc = getService(db, params.root_cause_service);
        if (svc) rootCauseServiceId = svc.id;
      }

      const incident = createIncident(db, {
        title: params.title,
        description: params.description,
        severity: params.severity as AlertSeverity,
        likely_cause: params.likely_cause,
        root_cause_service_id: rootCauseServiceId,
        runbook_used: params.runbook_used,
      });

      // Correlate alerts
      if (params.correlate_alert_ids) {
        for (const alertId of params.correlate_alert_ids) {
          correlateAlert(db, { incident_id: incident.id, alert_id: alertId });
        }
      }

      return toolResult({ incident, correlated_alerts: params.correlate_alert_ids || [] });
    } catch (err) { return toolError(err); }
  },
});

const updateIncidentTool = defineTool({
  name: "update_incident",
  label: "Update Incident",
  description: `Update an existing incident — change its status, update the description, refine the root cause assessment, or record the post-resolution root-cause analysis (rca).`,
  parameters: Type.Object({
    incident_id: Type.Number({ description: "Incident ID to update" }),
    status: Type.Optional(Type.String({ description: "New status: open, investigating, mitigated, or resolved" })),
    description: Type.Optional(Type.String({ description: "Updated description" })),
    likely_cause: Type.Optional(Type.String({ description: "Updated likely cause assessment" })),
    rca: Type.Optional(Type.String({ description: "Root-cause analysis written after the incident is resolved: what happened, why, how it was resolved (including any explanation the operator gave), and follow-up/prevention. Markdown allowed." })),
    root_cause_service: Type.Optional(Type.String({ description: "Updated root cause service name" })),
  }),
  executionMode: "sequential",
  execute: async (_id, params) => {
    try {
      let rootCauseServiceId;
      if (params.root_cause_service) {
        const svc = getService(db, params.root_cause_service);
        rootCauseServiceId = svc ? svc.id : null;
      }
      const incident = updateIncident(db, {
        id: params.incident_id,
        status: params.status as IncidentStatus | undefined,
        description: params.description,
        likely_cause: params.likely_cause,
        rca: params.rca,
        root_cause_service_id: rootCauseServiceId,
      });
      return toolResult(incident);
    } catch (err) { return toolError(err); }
  },
});

const listIncidentsTool = defineTool({
  name: "list_incidents",
  label: "List Incidents",
  description: `List incidents, optionally filtered by status. Use this to check for existing open incidents before creating a new one.`,
  parameters: Type.Object({
    status: Type.Optional(Type.String({ description: "Filter by status: open, investigating, mitigated, resolved" })),
  }),
  execute: async (_id, params) => {
    try {
      const incidents = listIncidents(db, { status: params.status });
      return toolResult({ incidents, count: incidents.length });
    } catch (err) { return toolError(err); }
  },
});

// ── Runbook Tools ──

const searchRunbooksTool = defineTool({
  name: "search_runbooks",
  label: "Search Runbooks",
  description: `Search runbooks by service name or keyword. Returns matching runbook steps, triggers, and known failure patterns. Use this after identifying which service is failing to find the correct remediation steps.`,
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Service name or keyword to search for, e.g. 'pgsql' or 'connection errors'" })),
    service: Type.Optional(Type.String({ description: "Specific service name: gateway, app-ui, app-api, auth, pgsql, redis" })),
  }),
  execute: async (_id, params) => {
    try {
      const runbooks = await loadAllRunbooks();
      let results = runbooks;

      if (params.service) {
        results = results.filter(r => r.service === params.service);
      } else if (params.query) {
        const q = params.query.toLowerCase();
        results = results.filter(r =>
          r.service.toLowerCase().includes(q) ||
          r.triggers.some(t => t.pattern.toLowerCase().includes(q))
        );
      }

      if (results.length === 0) {
        return toolResult({ message: "No matching runbooks found.", available_services: runbooks.map(r => r.service) });
      }

      return toolResult(results);
    } catch (err) { return toolError(err); }
  },
});

// ── Deployment Tools ──

const getRecentDeploymentsTool = defineTool({
  name: "get_recent_deployments",
  label: "Get Recent Deployments",
  description: `Check recent deployments across all services. Use this to see if a recent change might be causing the incident.`,
  parameters: Type.Object({
    hours: Type.Optional(Type.Number({ description: "How many hours back to look (default 24)" })),
  }),
  execute: async (_id, params) => {
    try {
      const deployments = listRecentDeployments(db, { hours: params.hours || 24 });
      return toolResult({ deployments, count: deployments.length });
    } catch (err) { return toolError(err); }
  },
});

// ── Notification Tools ──

const notifyChannelTool = defineTool({
  name: "notify_channel",
  label: "Notify Channel",
  description: `Send a notification to a Slack channel with a structured incident summary. Use this after creating an incident to inform the on-call team. Always include the incident ID, root cause theory, and recommended actions.`,
  parameters: Type.Object({
    incident_id: Type.Number({ description: "The incident ID to reference" }),
    channel: Type.String({ description: "Channel name, e.g. '#platform-engineering'" }),
    message: Type.String({ description: "Structured summary: root cause, affected services, recommended actions" }),
  }),
  executionMode: "sequential",
  execute: async (_id, params) => {
    try {
      // Record the notification
      const notification = createNotification(db, {
        incident_id: params.incident_id,
        channel: params.channel,
        message: params.message,
      });

      // Try to send to mock Slack webhook
      const webhookUrl = process.env.SLACK_WEBHOOK_URL || process.env.MOCK_SLACK_URL;
      let delivered = false;
      if (webhookUrl) {
        try {
          // The agent is the *narration* layer — label it "🤖 Argus" and reference the
          // incident so it reads as a threaded follow-up to the deterministic reflex ping
          // (which carries the "[Argus·system]" label), not a competing message.
          const resp = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel: params.channel,
              text: `🤖 Argus · Incident #${params.incident_id}\n${params.message}`,
              incident_id: params.incident_id,
            }),
          });
          delivered = resp.ok;
        } catch {
          // Webhook delivery failed, but notification is still recorded
        }
      }

      return toolResult({ notification, delivered, note: delivered ? "Notification delivered" : "Notification recorded (webhook not configured or unreachable)" });
    } catch (err) { return toolError(err); }
  },
});

// ── Confirmation Tools ──

const requestConfirmationTool = defineTool({
  name: "request_confirmation",
  label: "Request Confirmation",
  description: `Request human confirmation before executing a remediation step. ALWAYS call this before any executable runbook step. This records the request and returns it for the operator to approve.`,
  parameters: Type.Object({
    incident_id: Type.Number({ description: "The incident ID" }),
    action: Type.String({ description: "The action to confirm, e.g. 'Restart pgsql connection pooler'" }),
    requested_by: Type.Optional(Type.String({ description: "Who is requesting (default: argus)" })),
  }),
  executionMode: "sequential",
  execute: async (_id, params) => {
    try {
      const confirmation = createConfirmation(db, {
        incident_id: params.incident_id,
        action: params.action,
        requested_by: params.requested_by || "argus",
      });
      return toolResult({
        confirmation,
        message: `Confirmation requested for: "${params.action}". Waiting for human approval before executing.`,
      });
    } catch (err) { return toolError(err); }
  },
});

const executeRunbookStepTool = defineTool({
  name: "execute_runbook_step",
  label: "Execute Runbook Step",
  description: `Execute an approved runbook remediation step. You MUST call request_confirmation first and only call this once approval is on record. The step is identified by service and step_id; the actual command is read from the runbook by deterministic code, not taken from you. After it runs, the tool verifies the target service is healthy and reports what it observed; alert resolution is left to the normal detection path.`,
  parameters: Type.Object({
    incident_id: Type.Number({ description: "The incident ID" }),
    step_id: Type.Number({ description: "The runbook step ID to execute" }),
    service: Type.String({ description: "Service name the runbook belongs to" }),
    confirmation_id: Type.Number({ description: "The confirmation ID from request_confirmation" }),
  }),
  executionMode: "sequential",
  execute: async (_id, params) => {
    try {
      // Enforce the approval gate — the agent may only execute against an approved confirmation.
      const confirmation = db.query("SELECT * FROM confirmations WHERE id = ?").get(params.confirmation_id) as ConfirmationRow | null;
      if (!confirmation) {
        return toolResult({ error: `Confirmation ${params.confirmation_id} not found. You must request confirmation first.` });
      }
      if (confirmation.status !== "approved") {
        return toolResult({ error: `Confirmation ${params.confirmation_id} is "${confirmation.status || "pending"}", not approved. You may only execute after the operator approves in the UI.` });
      }

      // Loop guard: cap remediation attempts per incident.
      const attempts = getIncidentRemediationAttempts(db, params.incident_id);
      const cap = remediationAttemptCap();
      if (attempts >= cap) {
        const msg = `Remediation attempt cap (${cap}) reached for incident ${params.incident_id}. The incident stays open pending operator direction.`;
        createNotification(db, { incident_id: params.incident_id, channel: "#platform-engineering", message: msg });
        return toolResult({ error: msg, incident_id: params.incident_id, attempts, cap });
      }

      // Native modes have no Docker topology; refuse rather than pretend.
      const executorUrl = executorBaseUrl();
      if (!executorUrl) {
        return toolResult({
          error: "No remediation executor is configured. Container restart only works in the full Docker topology (`docker compose up`). In native mode, resolve the failure manually and the scraper/Alertmanager path will clear the alerts.",
          incident_id: params.incident_id,
        });
      }

      // Load the runbook and step. Deterministic code, not the model, decides what runs.
      const runbook = await loadRunbook(params.service);
      if (!runbook) {
        return toolResult({ error: `No runbook found for service "${params.service}".` });
      }
      const step = getRunbookStep(runbook, params.step_id);
      if (!step) {
        return toolResult({ error: `Step ${params.step_id} not found in ${params.service} runbook.` });
      }
      if (step.action !== "executable") {
        return toolResult({ error: `Step ${params.step_id} in ${params.service} runbook is "${step.action}", not "executable". Only executable steps can be run through the executor.` });
      }
      const target = step.target;
      if (!target || !EXECUTOR_ALLOWED_TARGETS.has(target)) {
        return toolResult({ error: `Step ${params.step_id} targets "${target ?? "unknown"}", which is not in the remediation allowlist. Allowed targets: ${[...EXECUTOR_ALLOWED_TARGETS].join(", ")}.` });
      }

      // Record that we are attempting remediation (atomic increment).
      incrementIncidentRemediationAttempts(db, params.incident_id);

      // Trigger the real container restart through the dedicated executor.
      let executorOutput: string | null = null;
      try {
        const resp = await fetch(`${executorUrl}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restart", target }),
          signal: AbortSignal.timeout(120000),
        });
        const data = await resp.json() as Record<string, unknown>;
        if (!resp.ok) {
          const detail = typeof data.error === "string" ? data.error : JSON.stringify(data);
          return toolResult({ error: `Executor refused: ${detail}`, incident_id: params.incident_id, step_id: params.step_id, service: params.service, target });
        }
        executorOutput = typeof data.output === "string" ? data.output : null;
      } catch (err) {
        return toolResult({
          error: `Failed to reach remediation executor at ${executorUrl}: ${err instanceof Error ? err.message : String(err)}`,
          incident_id: params.incident_id,
          attempts: getIncidentRemediationAttempts(db, params.incident_id),
        });
      }

      // Verify the restart had the intended effect before declaring the incident mitigated.
      const targetSvc = getService(db, target);
      if (!targetSvc) {
        return toolResult({ error: `Target service "${target}" is not known to Argus.`, incident_id: params.incident_id });
      }
      const healthy = await pollUntilHealthy(targetSvc, 8000, 750);

      if (!healthy) {
        return toolResult({
          error: `Restarted ${target}, but it did not return to healthy within the timeout — the incident remains open.`,
          incident_id: params.incident_id,
          step_id: params.step_id,
          service: params.service,
          target,
          attempts: getIncidentRemediationAttempts(db, params.incident_id),
          executor_output: executorOutput,
        });
      }

      // Success: stamp the cooldown so the scraper won't re-create alerts on a boundary reading.
      markServiceRecovered(db, targetSvc.id);

      // Mark the incident mitigated. Alert resolution is intentionally left to the detection
      // path (built-in scraper or vmalert → Alertmanager), not to this tool.
      updateIncident(db, { id: params.incident_id, status: "mitigated" });

      // Auto-decline any other pending confirmations for this incident — the fix ran.
      db.query(
        "UPDATE confirmations SET status = 'declined', resolved_at = datetime('now') WHERE incident_id = ? AND id != ? AND (status IS NULL OR status = 'pending')"
      ).run(params.incident_id, params.confirmation_id);

      return toolResult({
        incident_id: params.incident_id,
        step_id: params.step_id,
        service: params.service,
        target,
        status: "executed",
        executor_output: executorOutput,
        message: `Restarted ${target} via the executor and verified it returned to healthy. The incident is mitigated; alerts should clear through the normal detection path.`,
        timestamp: new Date().toISOString(),
      });
    } catch (err) { return toolError(err); }
  },
});

// ── Log Viewer Tools ──

const checkLogsTool = defineTool({
  name: "check_logs",
  label: "Check Logs",
  description: `Query infrastructure logs and metrics history to investigate incidents. Can query:
- "metrics" — recent time-series data from VictoriaMetrics for a specific metric or service (shows trends over the last 15 minutes)
- "vmalert" — current alert rule evaluation status from vmalert (which rules are firing, pending, or inactive)
- "docker" — recent container logs for the VictoriaMetrics stack (vm, vmalert, alertmanager)
- "all" — combines metrics summary, vmalert status, and docker logs

Use this when you need historical context, metric trends, or infrastructure logs that aren't available from the current alert data alone.`,
  parameters: Type.Object({
    source: Type.String({
      description: `Log source to query: "metrics", "vmalert", "docker", or "all"`,
      default: "all",
    }),
    service: Type.Optional(Type.String({
      description: `Service name for metrics queries: gateway, app-ui, app-api, auth, pgsql, redis. Required when source is "metrics".`,
    })),
    metric: Type.Optional(Type.String({
      description: `Specific metric name to query, e.g. "pgsql_connection_errors". If omitted, returns all metrics for the service.`,
    })),
    duration: Type.Optional(Type.String({
      description: `Time range for metrics queries, e.g. "5m", "15m", "1h". Default: "15m"`,
      default: "15m",
    })),
    lines: Type.Optional(Type.Number({
      description: `Number of log lines to return for docker logs. Default: 50`,
      default: 50,
    })),
  }),
  executionMode: "sequential",
  execute: async (_id, params) => {
    try {
      const source = params.source || "all";
      const results: Record<string, unknown> = {};

      // ── Metrics from VictoriaMetrics ──
      if (source === "metrics" || source === "all") {
        const vmUrl = process.env.VM_URL || "http://localhost:8428";
        const duration = params.duration || "15m";

        if (params.service || params.metric) {
          // Query specific service/metric
          let query;
          if (params.metric) {
            query = params.metric;
          } else {
            // Build a regex query for all metrics of a service
            query = `{service="${params.service}"}`;
          }

          try {
            // Get latest values
            const instantResp = await fetch(`${vmUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
            const instantData = await instantResp.json();

            // Get range data for trend
            const end = Math.floor(Date.now() / 1000);
            const start = end - parseDuration(duration);
            const step = Math.max(15, Math.floor(parseDuration(duration) / 60));
            const stepStr = `${step}s`;
            const rangeResp = await fetch(`${vmUrl}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=${stepStr}`);
            const rangeData = await rangeResp.json();

            results.metrics = {
              service: params.service,
              metric: params.metric,
              duration,
              current: formatInstantResults(instantData),
              trend: formatRangeResults(rangeData),
            };
          } catch (err) {
            results.metrics = { error: `VictoriaMetrics query failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        } else if (source === "metrics") {
          // No service specified — return overview
          try {
            const labelResp = await fetch(`${vmUrl}/api/v1/label/__name__/values`);
            const labels = await labelResp.json() as any;
            results.metrics = {
              message: "Specify a service or metric name to query metrics.",
              available_services: ["gateway", "app-ui", "app-api", "auth", "pgsql", "redis"],
              metric_count: labels.data?.length || 0,
            };
          } catch {
            results.metrics = { error: "VictoriaMetrics not reachable" };
          }
        }
      }

      // ── vmalert status ──
      if (source === "vmalert" || source === "all") {
        const vmalertUrl = process.env.VMALERT_URL || "http://localhost:8880";
        try {
          const resp = await fetch(`${vmalertUrl}/api/v1/rules`);
          const data = await resp.json() as any;
          const rules: Record<string, unknown>[] = [];
          for (const group of data.data?.groups || []) {
            for (const rule of group.rules || []) {
              rules.push({
                group: group.name,
                name: rule.name,
                state: rule.state,
                severity: rule.labels?.severity || "unknown",
                service: rule.labels?.service || "unknown",
                value: rule.alerts?.[0]?.value || rule.value || "N/A",
              });
            }
          }
          const firing = rules.filter(r => r.state === "firing");
          const pending = rules.filter(r => r.state === "pending");
          results.vmalert = {
            total_rules: rules.length,
            firing: firing.length,
            pending: pending.length,
            inactive: rules.length - firing.length - pending.length,
            firing_rules: firing,
            pending_rules: pending,
          };
        } catch {
          results.vmalert = { error: "vmalert not reachable" };
        }
      }

      // ── Docker container logs ──
      if (source === "docker" || source === "all") {
        const maxLines = params.lines || 50;
        const containers = ["argus-vm", "argus-vmalert", "argus-alertmanager"];
        const dockerLogs: Record<string, string> = {};

        for (const container of containers) {
          try {
            const proc = Bun.spawnSync(["docker", "logs", "--tail", String(maxLines), container], {
              stdout: "pipe",
              stderr: "pipe",
            });
            const output = (proc.stdout?.toString() || "").trim();
            const errors = (proc.stderr?.toString() || "").trim();
            const combined = (output + "\n" + errors).trim();
            dockerLogs[container] = combined
              ? combined.split("\n").slice(-maxLines).join("\n")
              : "(no logs)";
          } catch {
            dockerLogs[container] = "(docker not available)";
          }
        }
        results.docker = dockerLogs;
      }

      return toolResult(results);
    } catch (err) { return toolError(err); }
  },
});

// ── Helpers ──

interface RunbookTrigger { pattern: string; [k: string]: unknown }
interface RunbookStep {
  id: number;
  title?: string;
  action: string;
  instruction?: string;
  target?: string;
  command?: string;
  requires_confirmation?: boolean;
  rollback?: string;
  [k: string]: unknown;
}
interface Runbook { service: string; triggers: RunbookTrigger[]; steps: RunbookStep[]; [k: string]: unknown }

const EXECUTOR_ALLOWED_TARGETS = new Set(["gateway", "app-ui", "app-api", "auth", "pgsql", "redis"]);
const DEFAULT_REMEDIATION_ATTEMPT_CAP = 3;

function remediationAttemptCap(): number {
  const env = process.env.REMEDIATION_ATTEMPT_CAP;
  if (!env) return DEFAULT_REMEDIATION_ATTEMPT_CAP;
  const n = Number.parseInt(env, 10);
  return Number.isNaN(n) || n < 1 ? DEFAULT_REMEDIATION_ATTEMPT_CAP : n;
}

async function loadAllRunbooks(): Promise<Runbook[]> {
  try {
    const files = await readdir(RUNBOOKS_DIR);
    const yamls = files.filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
    const runbooks: Runbook[] = [];
    for (const file of yamls) {
      const content = await readFile(join(RUNBOOKS_DIR, file), "utf-8");
      const parsed = parseYaml(content) as unknown as Runbook;
      runbooks.push(parsed);
    }
    return runbooks;
  } catch {
    return [];
  }
}

async function loadRunbook(service: string): Promise<Runbook | null> {
  try {
    const files = await readdir(RUNBOOKS_DIR);
    const file = files.find(f => f === `${service}.yaml` || f === `${service}.yml`);
    if (!file) return null;
    const content = await readFile(join(RUNBOOKS_DIR, file), "utf-8");
    return parseYaml(content) as unknown as Runbook;
  } catch {
    return null;
  }
}

function getRunbookStep(runbook: Runbook, stepId: number): RunbookStep | null {
  if (!Array.isArray(runbook.steps)) return null;
  return runbook.steps.find((s: RunbookStep) => s.id === stepId) || null;
}

// Resolve the base URL of the remediation executor. Native modes leave this unset;
// the tool refuses to execute rather than pretending it can restart containers.
function executorBaseUrl(): string | null {
  const raw = process.env.EXECUTOR_URL?.trim();
  return raw || null;
}

// Poll a service's /metrics until it reads healthy, or the bounded timeout elapses.
// Used by execute_runbook_step to confirm a recovery actually took before clearing alerts.
async function pollUntilHealthy(svc: ServiceRow, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const resp = await fetch(`${serviceBaseUrl(svc)}/metrics`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const metrics = parsePrometheusMetrics(await resp.text());
        if (determineServiceStatus(svc.name, metrics) === "healthy") return true;
      }
    } catch { /* unreachable/slow — keep polling until the deadline */ }
    if (Date.now() + intervalMs >= deadline) return false;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

function parsePrometheusMetrics(text: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(\w+)(?:\{[^}]*\})?\s+([\d.]+)$/);
    if (match) {
      metrics[match[1]] = parseFloat(match[2]);
    }
  }
  return metrics;
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(m|h|s)$/);
  if (!match) return 900; // default 15m
  const value = parseInt(match[1]);
  if (match[2] === "s") return value;
  if (match[2] === "m") return value * 60;
  if (match[2] === "h") return value * 3600;
  return 900;
}

// VictoriaMetrics query responses are external JSON — typed loosely at this boundary.
function formatInstantResults(data: any) {
  if (!data?.data?.result) return [];
  return data.data.result.map((r: any) => ({
    metric: r.metric?.__name__ || r.metric?.service || "unknown",
    service: r.metric?.service || "unknown",
    value: r.value?.[1] || "N/A",
    labels: Object.fromEntries(
      Object.entries(r.metric || {}).filter(([k]) => !["__name__", "job", "instance"].includes(k))
    ),
  }));
}

function formatRangeResults(data: any) {
  if (!data?.data?.result) return [];
  return data.data.result.map((r: any) => {
    const values = (r.values || []).map((v: [number, string]) => ({
      timestamp: new Date(v[0] * 1000).toISOString(),
      value: parseFloat(v[1]),
    }));
    return {
      metric: r.metric?.__name__ || "unknown",
      service: r.metric?.service || "unknown",
      data_points: values.length,
      values: values.slice(-10), // last 10 data points for readability
    };
  });
}

type Threshold = number | { threshold: number; direction: string };

function determineServiceStatus(serviceName: string, metrics: Record<string, number>): ServiceStatus {
  const thresholds: Record<string, Record<string, Threshold>> = {
    gateway: { gateway_upstream_error_rate: 0.30 },
    "app-ui": { appui_http_error_rate: 0.30 },
    "app-api": { appapi_http_error_rate: 0.30 },
    auth: { auth_token_validation_errors: 10 },
    pgsql: { pgsql_connection_errors: 3 },
    redis: { redis_memory_used_ratio: 0.85, redis_cache_hit_rate: { threshold: 0.70, direction: "below" } },
  };
  const checks = thresholds[serviceName];
  if (!checks) return "unknown";
  for (const [metric, config] of Object.entries(checks)) {
    if (metrics[metric] !== undefined) {
      const threshold = typeof config === "object" ? config.threshold : config;
      const isBelow = typeof config === "object" && config.direction === "below";
      const triggered = isBelow ? metrics[metric] <= threshold : metrics[metric] >= threshold;
      if (triggered) return "failing";
    }
  }
  return "healthy";
}

export const argusTools = [
  getAlertTool,
  listActiveAlertsTool,
  listAllAlertsTool,
  checkServiceHealthTool,
  createIncidentTool,
  updateIncidentTool,
  listIncidentsTool,
  searchRunbooksTool,
  getRecentDeploymentsTool,
  notifyChannelTool,
  requestConfirmationTool,
  executeRunbookStepTool,
  checkLogsTool,
];