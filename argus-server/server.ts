import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ServerWebSocket } from "bun";
import type {
  ServiceRow, AlertRow, AlertWithService, IncidentRow, ConfirmationRow,
  Workflow, WorkflowStep, AgentTask,
} from "./db/types.ts";
import { initDb } from "./db/schema.js";
import { seedIfEmpty } from "./db/seed.js";
import { initArgusTools, argusTools } from "./tools/argus-tools.js";
// git tool intentionally excluded — incident triage has no business committing code
import { getSystemPrompt } from "./agent/system-prompt.js";
import { renderMetrics, recordToolCall, recordTurn, recordError } from "./metrics.js";
import { computeWorkflowStep } from "./db/workflow.js";
import { serviceBaseUrl } from "./service-url.js";
import {
  listServices,
  getService,
  createAlert,
  listActiveAlerts,
  resolveAlert,
  createIncident,
  updateIncident,
  listIncidents,
  correlateAlert,
  listRecentDeployments,
  createNotification,
  listNotifications,
  createConfirmation,
  insertMessage,
  setThreadAlias,
  listChat,
  deleteMessagesForClosedIncidents,
  isServiceInCooldown,
} from "./db/api.js";

const APP_DIR = fileURLToPath(new URL(".", import.meta.url));
const DIST_DIR = resolve(APP_DIR, "dist");
const REPO_ROOT = resolve(APP_DIR, "..");
const LOCAL_AGENT_DIR = resolve(REPO_ROOT, ".pi", "agent");
// DB_PATH lets the Docker Compose path point SQLite at a mounted volume (e.g. /data/argus.db)
// so incident history survives `docker compose down`. Defaults to argus-server/argus.db.
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(APP_DIR, "argus.db");
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const DISABLE_SCRAPER = process.env.DISABLE_SCRAPER === "1";
// External/auto-resolved incidents: how long to WAIT for the operator to say how it was
// resolved before falling back to a research-only RCA so the workflow never hangs.
const RCA_OPERATOR_TIMEOUT_MS = Number.parseInt(process.env.RCA_OPERATOR_TIMEOUT_SEC || "180", 10) * 1000;

// ── Logging ──

type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = LEVELS[LOG_LEVEL as LogLevel] ?? LEVELS.info;

function log(level: LogLevel, tag: string, msg: unknown, ...args: unknown[]) {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}] ${tag ? `[${tag}] ` : ""}${typeof msg === "string" ? msg : JSON.stringify(msg)}`;
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](line, ...args);
}

// ── Connected UI clients + broadcast ──
// Declared early so the headless agent (kicked off during module init) can broadcast
// without a temporal-dead-zone race against the rest of module evaluation.
const clients = new Set<ServerWebSocket<unknown>>();
function broadcast(payload: unknown) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    try { ws.send(msg); } catch { /* closed */ }
  }
}

// ── Startup ──

await mkdir(LOCAL_AGENT_DIR, { recursive: true });

// Ollama lives OUTSIDE the container (host GPU / a cloud model), so the committed
// .pi/agent/models.json points the ollama provider at localhost:11434. When OLLAMA_BASE_URL
// is set (Docker Compose sets it to http://host.docker.internal:11434 — the one cross-boundary
// link), rewrite that provider's baseUrl so the agent can reach Ollama on the host. The write
// is idempotent: under `mise run dev` (OLLAMA_BASE_URL=http://localhost:11434) it resolves to
// the value already on disk, so nothing is written and the working tree stays clean.
applyOllamaBaseUrlOverride();
function applyOllamaBaseUrlOverride() {
  const raw = process.env.OLLAMA_BASE_URL;
  if (!raw) return;
  const baseUrl = `${raw.replace(/\/+$/, "")}/v1`;
  const modelsPath = join(LOCAL_AGENT_DIR, "models.json");
  if (!existsSync(modelsPath)) return;
  try {
    const before = readFileSync(modelsPath, "utf-8");
    const config = JSON.parse(before);
    if (!config?.providers?.ollama || config.providers.ollama.baseUrl === baseUrl) return;
    config.providers.ollama.baseUrl = baseUrl;
    const after = JSON.stringify(config, null, 2) + "\n";
    if (after !== before) {
      writeFileSync(modelsPath, after);
      log("info", "server", `Ollama endpoint set to ${baseUrl} (from OLLAMA_BASE_URL)`);
    }
  } catch (err) {
    log("warn", "server", `Could not apply OLLAMA_BASE_URL override: ${err instanceof Error ? err.message : String(err)}`);
  }
}

log("info", "server", "Initializing database…");
const db = initDb(DB_PATH);
log("info", "server", `Database ready at ${DB_PATH}`);

await seedIfEmpty(db);
initArgusTools(db);
log("info", "server", `Tools loaded: ${argusTools.map(t => t.name).join(", ")}`);

const systemPrompt = getSystemPrompt();
log("info", "server", `System prompt loaded (${systemPrompt.length} chars)`);

// ── Alert scraper: periodically check demo services ──

const ALERT_INTERVAL = 15_000; // 15 seconds
// After the agent recovers a service we stamp services.recovered_at; the scraper suppresses
// NEW alert creation for this window so a metrics reading captured around the recovery
// boundary doesn't spawn a phantom "Detected" workflow. Short enough that a genuinely new
// failure later still detects normally. Sized above the worst-case late-FIRING lag under
// Alertmanager (scrape 15s + vmalert for:10s + group_wait/interval) so a notification
// evaluated on a pre-recovery scrape can't slip through after the window.
const RECOVERY_COOLDOWN_SEC = 30;
type MetricThreshold = { warn: number; crit: number; direction?: string };
const THRESHOLDS: Record<string, Record<string, MetricThreshold>> = {
  gateway: { gateway_upstream_error_rate: { warn: 0.30, crit: 0.60 } },
  "app-ui": { appui_http_error_rate: { warn: 0.30, crit: 0.60 }, appui_asset_load_failures: { warn: 5, crit: 10 }, appui_ssr_errors: { warn: 1, crit: 1 } },
  "app-api": { appapi_http_error_rate: { warn: 0.30, crit: 0.60 }, appapi_dependency_errors: { warn: 10, crit: 20 } },
  auth: { auth_token_validation_errors: { warn: 50, crit: 100 }, auth_login_failures: { warn: 20, crit: 50 }, auth_session_errors: { warn: 10, crit: 30 } },
  pgsql: { pgsql_connection_errors: { warn: 5, crit: 10 }, pgsql_connection_pool_used: { warn: 0.85, crit: 0.95 }, pgsql_query_duration_p99_ms: { warn: 5000, crit: 15000 }, pgsql_replication_lag_seconds: { warn: 10, crit: 30 } },
  redis: { redis_connection_errors: { warn: 3, crit: 6 }, redis_memory_used_ratio: { warn: 0.85, crit: 0.95 }, redis_cache_hit_rate: { warn: 0.70, crit: 0.30, direction: "below" }, redis_evicted_keys: { warn: 100, crit: 1000 } },
};

async function scrapeAndAlert() {
  const services = listServices(db);
  for (const svc of services) {
    try {
      const resp = await fetch(`${serviceBaseUrl(svc)}/metrics`, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) continue;
      const text = await resp.text();
      const metrics = parsePrometheusMetrics(text);

      // Update service status in DB
      const status = determineServiceStatus(svc.name, metrics);
      if (status !== svc.status) {
        db.query("UPDATE services SET status = ?, last_checked = datetime('now') WHERE id = ?").run(status, svc.id);
      }

      // Check thresholds and create alerts
      const serviceThresholds = THRESHOLDS[svc.name];
      if (!serviceThresholds) continue;

      // Post-recovery cooldown: suppress NEW alert creation for a freshly-recovered service
      // (updates to existing alerts and resolutions still flow through).
      const cooling = isServiceInCooldown(db, svc.id, RECOVERY_COOLDOWN_SEC);

      for (const [metricName, thresholds] of Object.entries(serviceThresholds)) {
        const value = metrics[metricName];
        if (value === undefined) continue;

        // Check if alert already firing for this metric
        const existing = db.query(
          "SELECT * FROM alerts WHERE service_id = ? AND metric_name = ? AND status = 'firing'"
        ).get(svc.id, metricName) as AlertRow | null;

        const isBelow = thresholds.direction === "below";
        const isCrit = isBelow ? value <= thresholds.crit : value >= thresholds.crit;
        const isWarn = isBelow ? value <= thresholds.warn : value >= thresholds.warn;
        const isHealthy = !isWarn;

        const directionLabel = isBelow ? "below" : "above";

        if (isCrit) {
          if (!existing) {
            if (cooling) {
              log("debug", "alert", `Suppressed (cooldown): ${svc.name} ${metricName}=${value}`);
              continue;
            }
            createAlert(db, {
              service_id: svc.id,
              severity: "critical",
              metric_name: metricName,
              metric_value: value,
              threshold: thresholds.crit,
              message: `${svc.name}: ${metricName} is ${value} (${directionLabel} threshold: ${thresholds.crit})`,
            });
            log("warn", "alert", `CRITICAL alert: ${svc.name} ${metricName}=${value}`);
          } else {
            db.query("UPDATE alerts SET metric_value = ? WHERE id = ?").run(value, existing.id);
          }
        } else if (isWarn) {
          if (!existing) {
            if (cooling) {
              log("debug", "alert", `Suppressed (cooldown): ${svc.name} ${metricName}=${value}`);
              continue;
            }
            createAlert(db, {
              service_id: svc.id,
              severity: "warning",
              metric_name: metricName,
              metric_value: value,
              threshold: thresholds.warn,
              message: `${svc.name}: ${metricName} is ${value} (${directionLabel} threshold: ${thresholds.warn})`,
            });
            log("info", "alert", `WARNING alert: ${svc.name} ${metricName}=${value}`);
          } else {
            db.query("UPDATE alerts SET metric_value = ?, severity = ? WHERE id = ?").run(value, "warning", existing.id);
          }
        } else if (isHealthy) {
          if (existing) {
            resolveAlert(db, existing.id);
            log("info", "alert", `Resolved: ${svc.name} ${metricName} back to ${value}`);
          }
        }
      }
    } catch (err) {
      // Service unreachable
      if (svc.status !== "unknown") {
        db.query("UPDATE services SET status = 'unknown', last_checked = datetime('now') WHERE id = ?").run(svc.id);
      }
    }
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

function determineServiceStatus(serviceName: string, metrics: Record<string, number>): ServiceRow["status"] {
  const thresholds = THRESHOLDS[serviceName];
  if (!thresholds) return "unknown";
  for (const [metric, levels] of Object.entries(thresholds)) {
    if (metrics[metric] !== undefined) {
      const isBelow = levels.direction === "below";
      const triggered = isBelow ? metrics[metric] <= levels.warn : metrics[metric] >= levels.warn;
      if (triggered) return "failing";
    }
  }
  return "healthy";
}

// Start alert scraper (skip when vmalert+Alertmanager provides alerts)
if (DISABLE_SCRAPER) {
  log("info", "server", "Built-in scraper disabled — expecting alerts from Alertmanager webhook");
} else {
  const alertTimer = setInterval(scrapeAndAlert, ALERT_INTERVAL);
  scrapeAndAlert().catch(err => log("error", "alert", `Initial scrape failed: ${err.message}`));
}

// Autonomous triage reconciler — dispatches auto-investigate / auto-RCA directives
const TRIAGE_INTERVAL = 4_000;
setInterval(() => {
  try { reconcileTriage(); } catch (e) { log("warn", "triage", `tick failed: ${getErrorMessage(e)}`); }
}, TRIAGE_INTERVAL);

// ── Headless server-side agent ──
// A single persistent Pi session runs ALL triage server-side, with no browser required.
// Tasks (investigate / execute / rca / user chat) are queued and processed sequentially;
// streamed output is broadcast to every connected UI tagged with the workflowId so each
// client renders it in the right chat. Durability: the reconciler re-derives pending work
// from SQLite every tick, so autonomy resumes after a restart and never depends on a client.
interface SessionMetadata {
  provider: string;
  model: string;
  thinkingLevel: string;
  tools: string[];
  availableModels: unknown[];
}

interface ServerAgentState {
  session: AgentSession | null;
  metadata: SessionMetadata | null;
  queue: AgentTask[];
  busy: boolean;
  current: AgentTask | null;
  guard: { text: string; blocked: boolean } | null;
  responseBuf: string; // accumulates the current turn's agent text for durable persistence
  turnStartedAt?: number; // performance.now() at agent_start, for turn-latency metric
  _keys?: Set<string>;
}

const serverAgent: ServerAgentState = {
  session: null,
  metadata: null,
  queue: [],
  busy: false,
  current: null,
  guard: null,
  responseBuf: "",
};

async function startServerAgent() {
  const loader = new DefaultResourceLoader({
    cwd: REPO_ROOT,
    agentDir: LOCAL_AGENT_DIR,
    systemPromptOverride: () => systemPrompt,
    agentsFilesOverride: (current) => ({
      agentsFiles: [
        ...current.agentsFiles,
        {
          path: ".pi/agent/AGENT.md",
          content: "# Argus Agent\n\nYou are an incident triage agent. Only handle incident investigation, alert analysis, and runbook execution. Never help with anything outside incident triage.",
        },
        {
          path: "argus-context.md",
          content: `# Argus Context\n\nArgus monitors a microservices stack with 6 services:\n- gateway (port 8081, tier: gateway)\n- app-ui (port 8082, tier: frontend)\n- app-api (port 8083, tier: backend)\n- auth (port 8084, tier: auth)\n- pgsql (port 8085, tier: database)\n- redis (port 8086, tier: cache)\n\nService dependencies:\n- gateway → app-ui, app-api\n- app-api → auth, pgsql, redis\n- auth → pgsql, redis\n- pgsql and redis are foundational\n\nAll data is in the SQLite database. Use your tools to investigate. Never write raw SQL.`,
        },
      ],
    }),
  });
  await loader.reload();

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: REPO_ROOT,
    agentDir: LOCAL_AGENT_DIR,
    sessionManager: SessionManager.inMemory(),
    noTools: "builtin",
    tools: argusTools.map(t => t.name),
    customTools: [...argusTools],
    resourceLoader: loader,
  });

  serverAgent.session = session;
  serverAgent.metadata = getSessionMetadata(session);
  const registeredTools = session.agent?.state?.tools?.map(t => t.name) || [];
  log("info", "session", `Headless agent ready — ${registeredTools.length} tools: ${registeredTools.join(", ")}`);
  if (modelFallbackMessage) log("warn", "session", `Model fallback: ${modelFallbackMessage}`);
  broadcast({ type: "metadata", metadata: serverAgent.metadata }); // refresh any clients connected during boot

  session.subscribe((event: AgentSessionEvent) => {
    const wid = serverAgent.current?.workflowId;
    const tag = (msg: Record<string, unknown>) => broadcast({ ...msg, workflowId: wid });

    if (event.type === "agent_start") {
      serverAgent.guard = { text: "", blocked: false };
      serverAgent.responseBuf = "";
      serverAgent.turnStartedAt = performance.now();
      tag({ type: "thinking", delta: "", reset: true });
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const g = serverAgent.guard;
      if (g && !g.blocked) {
        g.text += event.assistantMessageEvent.delta;
        if (isOffTopic(g.text.toLowerCase())) {
          log("warn", "guardrail", "Response blocked (off-topic)");
          g.blocked = true;
          serverAgent.responseBuf = "I'm Argus. I handle incident triage only.";
          tag({ type: "text", delta: serverAgent.responseBuf });
          tag({ type: "done", metadata: serverAgent.metadata });
          return;
        }
      }
      if (g?.blocked) return;
      serverAgent.responseBuf += event.assistantMessageEvent.delta;
      tag({ type: "text", delta: event.assistantMessageEvent.delta });
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      tag({ type: "thinking", delta: event.assistantMessageEvent.delta });
    } else if (event.type === "tool_execution_start") {
      log("info", "tool", `▶ ${event.toolName}`);
      recordToolCall(event.toolName);
      tag({ type: "tool_start", name: event.toolName });
    } else if (event.type === "tool_execution_end") {
      log("info", "tool", `${event.isError ? "✗" : "✓"} ${event.toolName}`);
      tag({ type: "tool_end", success: !event.isError });
      // When the agent creates an incident, bind the investigation thread it's running under
      // (svc-<service>-<ts>) to the new incident's workflow (inc-N). This is the authoritative
      // svc→inc link: it works even when the agent root-causes to a DIFFERENT service than the
      // one that alerted (a cascade — e.g. pgsql alerts, root cause gateway), which the
      // service-name-based reconciler guess could not. Tasks run sequentially, so the
      // just-created incident is the newest row.
      if (event.toolName === "create_incident" && !event.isError && wid && wid.startsWith("svc-")) {
        linkInvestigationToIncident(wid);
      }
    } else if (event.type === "agent_end") {
      // Record turn-latency telemetry (token/cost totals are read from getSessionStats at scrape time).
      if (serverAgent.turnStartedAt != null) recordTurn(performance.now() - serverAgent.turnStartedAt);
      // Persist the completed agent turn under the current workflow (durable transcript).
      const text = serverAgent.responseBuf.trim();
      if (text && wid) {
        try { insertMessage(db, { thread_key: wid, role: "agent", content: text }); }
        catch (e) { log("warn", "agent", `persist agent message failed: ${getErrorMessage(e)}`); }
      }
      serverAgent.responseBuf = "";
      tag({ type: "thinking", delta: "", reset: true });
      tag({ type: "done", metadata: serverAgent.metadata });
    }
  });
}

// Enqueue a task for the headless agent. dedupeKey (optional) prevents duplicate enqueues.
function enqueueAgentTask(task: AgentTask): boolean {
  if (task.dedupeKey) {
    serverAgent._keys ||= new Set();
    if (serverAgent._keys.has(task.dedupeKey)) return false;
    serverAgent._keys.add(task.dedupeKey);
  }
  serverAgent.queue.push(task);
  pumpAgent();
  return true;
}

async function pumpAgent() {
  if (serverAgent.busy || !serverAgent.session) return;
  const task = serverAgent.queue.shift();
  if (!task) return;
  serverAgent.busy = true;
  serverAgent.current = task;
  // Autonomous tasks show a synthetic "Auto-triage" chip; user messages were already
  // echoed optimistically by the client, so they don't get one.
  if (task.synthetic) {
    broadcast({ type: "agent_prompt", workflowId: task.workflowId, label: task.label });
  }
  // Persist the operator-visible side of the prompt (durable transcript).
  if (task.workflowId) {
    try {
      insertMessage(db, task.synthetic
        ? { thread_key: task.workflowId, role: "user", content: task.label || "Auto-triage", auto: 1 }
        : { thread_key: task.workflowId, role: "user", content: task.prompt, auto: 0 });
    } catch (e) { log("warn", "agent", `persist user message failed: ${getErrorMessage(e)}`); }
  }
  const preview = task.prompt.length > 120 ? `${task.prompt.slice(0, 120)}…` : task.prompt;
  log("info", "agent", `▶ [${task.workflowId}] ${task.synthetic ? "auto" : "user"}: ${preview}`);
  try {
    await serverAgent.session.prompt(task.prompt);
  } catch (e) {
    recordError();
    log("error", "agent", `prompt failed: ${getErrorMessage(e)}`);
    broadcast({ type: "error", workflowId: task.workflowId, message: getErrorMessage(e) });
  } finally {
    serverAgent.busy = false;
    serverAgent.current = null;
    pumpAgent();
  }
}

// Boot the headless agent (non-blocking — the server can accept connections meanwhile).
startServerAgent().catch(e => log("error", "session", `Headless agent failed to start: ${e.message}`));

function isOffTopic(text: string): boolean {
  const offTopicPatterns = [
    /\bwrite me (a |an )?(poem|story|essay|song|joke|recipe)\b/i,
    /\bwhat is the (meaning of life|weather|capital)\b/i,
    /\b(help me )?(hack|crack|exploit)\b/i,
  ];
  // Only block very obvious off-topic, let the system prompt handle the rest
  return offTopicPatterns.some(p => p.test(text));
}

function getSessionMetadata(session: AgentSession): SessionMetadata {
  const model = session.model as { provider?: string; id?: string; modelId?: string } | undefined;
  return {
    provider: model?.provider || "unknown",
    model: model?.id || model?.modelId || "unknown",
    thinkingLevel: session.thinkingLevel || "unknown",
    tools: session.agent?.state?.tools?.map(t => t.name).filter(Boolean) || [],
    availableModels: getConfiguredModels(),
  };
}

interface ModelConfigEntry { id: string; contextWindow?: number; reasoning?: boolean }

function getConfiguredModels(): unknown[] {
  try {
    const modelsPath = join(LOCAL_AGENT_DIR, "models.json");
    if (!existsSync(modelsPath)) return [];
    const config = JSON.parse(readFileSync(modelsPath, "utf-8")) as { providers?: Record<string, { models?: ModelConfigEntry[] }> };
    return Object.entries(config.providers || {}).flatMap(([provider, providerConfig]) =>
      (providerConfig.models || []).map(model => ({
        provider,
        id: model.id,
        label: `${provider}/${model.id}`,
        contextWindow: model.contextWindow,
        reasoning: Boolean(model.reasoning),
      })).filter(model => model.id)
    );
  } catch {
    return [];
  }
}

// ── Server ──

const server = Bun.serve<unknown>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    log("debug", "http", `${req.method} ${url.pathname}`);

    // WebSocket for agent chat (display + user input; the agent itself lives server-side)
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: {} })) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── Webhook endpoints for external alert receivers ──

    if (url.pathname === "/api/alerts/alertmanager" && req.method === "POST") {
      return handleAlertmanagerWebhook(req);
    }

    if (url.pathname === "/api/alerts" && req.method === "POST") {
      return handleCreateAlert(req);
    }

    if (url.pathname === "/api/alerts" && req.method === "GET") {
      const alerts = listActiveAlerts(db);
      return Response.json({ alerts, count: alerts.length });
    }

    if (url.pathname === "/api/services" && req.method === "GET") {
      const services = listServices(db);
      return Response.json({ services });
    }

    if (url.pathname === "/api/incidents" && req.method === "GET") {
      const status = url.searchParams.get("status");
      const incidents = listIncidents(db, { status });
      return Response.json({ incidents, count: incidents.length });
    }

    if (url.pathname === "/api/deployments" && req.method === "GET") {
      const hours = Number(url.searchParams.get("hours") || 24);
      const deployments = listRecentDeployments(db, { hours });
      return Response.json({ deployments, count: deployments.length });
    }

    if (url.pathname === "/api/notifications" && req.method === "GET") {
      const incidentId = url.searchParams.get("incident_id");
      const notifications = incidentId
        ? listNotifications(db, Number(incidentId))
        : db.query("SELECT n.*, i.title AS incident_title FROM notifications n LEFT JOIN incidents i ON n.incident_id = i.id ORDER BY n.sent_at DESC LIMIT 50").all();
      return Response.json({ notifications, count: notifications.length });
    }

    if (url.pathname === "/api/workflows" && req.method === "GET") {
      return handleWorkflows();
    }

    if (url.pathname === "/api/chat" && req.method === "GET") {
      return Response.json({ threads: listChat(db) });
    }

    const confirmMatch = url.pathname.match(/^\/api\/confirmations\/(\d+)\/(approve|decline)$/);
    if (confirmMatch && req.method === "POST") {
      return handleConfirmationDecision(Number(confirmMatch[1]), confirmMatch[2]);
    }

    if (url.pathname === "/api/workflows/clear" && req.method === "POST") {
      return handleClearResolved();
    }

    // Self-observability: agent token/cost/latency/tool telemetry in Prometheus format.
    // Scraped by VictoriaMetrics under infra:start; curl-able directly under mise run dev.
    if (url.pathname === "/metrics" && req.method === "GET") {
      return new Response(renderMetrics(serverAgent), {
        headers: { "Content-Type": "text/plain; version=0.0.4" },
      });
    }

    // Serve frontend
    return serveFileFromRoot(DIST_DIR, url.pathname, true);
  },
  websocket: {
    open(ws) {
      log("info", "ws", "Client connected");
      clients.add(ws);
      // The agent is shared and server-side; just hand the client current metadata.
      send(ws, { type: "ready", metadata: serverAgent.metadata || { provider: "…", model: "starting", tools: [] } });
      // If a turn is mid-flight, seed this client with the partial agent text so a
      // refresh during streaming doesn't lose the in-progress message. Sent over the same
      // ordered socket, so subsequent deltas cleanly append after this baseline.
      if (serverAgent.busy && serverAgent.current?.workflowId && serverAgent.responseBuf) {
        send(ws, { type: "agent_seed", workflowId: serverAgent.current.workflowId, content: serverAgent.responseBuf });
      }
    },
    message(ws, raw) {
      handleClientMessage(ws, raw).catch((error) => {
        log("error", "ws", `Message handling error: ${getErrorMessage(error)}`);
        send(ws, { type: "error", message: getErrorMessage(error) });
      });
    },
    close(ws) {
      log("info", "ws", "Client disconnected");
      clients.delete(ws);
    },
  },
});

log("info", "server", `Argus listening on http://127.0.0.1:${server.port}`);
log("info", "server", "Alert scraper running (15s interval)");

// ── Workflows endpoint ──
// Computes workflow state for each service from alerts + incidents + notifications + confirmations

function handleWorkflows() {
  const workflows = computeWorkflows();
  return Response.json({ workflows, count: workflows.length });
}

function computeWorkflows(): Workflow[] {
  const services = listServices(db);
  const alerts = db.query(
    `SELECT a.*, s.name AS service_name, s.tier AS service_tier
     FROM alerts a
     JOIN services s ON s.id = a.service_id
     ORDER BY a.fired_at DESC`
  ).all() as AlertWithService[];
  const incidents = db.query("SELECT * FROM incidents ORDER BY created_at DESC").all() as IncidentRow[];
  const confirmations = db.query("SELECT * FROM confirmations ORDER BY created_at DESC").all() as ConfirmationRow[];
  const correlations = db.query("SELECT * FROM incident_alerts").all() as { incident_id: number; alert_id: number }[];

  const incidentMap: Record<number, IncidentRow> = Object.fromEntries(incidents.map(i => [i.id, i]));
  const alertById: Record<number, AlertWithService> = Object.fromEntries(alerts.map(a => [a.id, a]));
  const alertToIncidents: Record<number, number[]> = {};
  for (const c of correlations) {
    (alertToIncidents[c.alert_id] ||= []).push(c.incident_id);
  }

  const isClosed = (inc: IncidentRow | null | undefined): boolean =>
    !!inc && (inc.status === "resolved" || inc.status === "mitigated");

  const workflows: Workflow[] = [];
  // Services with an open (non-closed) incident — their firing alerts belong to that
  // incident, never to a separate pending workflow.
  const openIncidentServices = new Set<string>();

  // 1) One workflow per incident — preserves history when the same service fails again.
  for (const inc of incidents) {
    const correlatedIds = correlations.filter(c => c.incident_id === inc.id).map(c => c.alert_id);
    const correlatedAlerts = correlatedIds.map(id => alertById[id]).filter(Boolean);
    const resolved = correlatedAlerts.filter(a => a.status === "resolved");

    // Resolve the service name: prefer root_cause_service, else most-correlated service
    let svcName: string | null = null;
    if (inc.root_cause_service_id) {
      svcName = services.find(s => s.id === inc.root_cause_service_id)?.name ?? null;
    }
    if (!svcName && correlatedAlerts[0]) svcName = correlatedAlerts[0].service_name;
    const svc = services.find(s => s.name === svcName);

    // Firing alerts = the correlated ones, plus any orphan firing alerts on the same
    // service (the agent doesn't always correlate every alert). This keeps one workflow
    // per service while an incident is open instead of leaking a duplicate "detected" one.
    const firing = correlatedAlerts.filter(a => a.status === "firing");
    if (!isClosed(inc) && svcName) {
      openIncidentServices.add(svcName);
      for (const a of alerts) {
        if (a.status !== "firing" || a.service_name !== svcName) continue;
        if ((alertToIncidents[a.id] || []).length > 0) continue; // owned by some incident already
        if (firing.some(f => f.id === a.id)) continue;
        firing.push(a);
      }
    }

    const incConfs = confirmations.filter(c => c.incident_id === inc.id);
    const step = computeWorkflowStep(firing, inc, incConfs);

    const firstAlertAt = correlatedAlerts.reduce<string | null>(
      (min, a) => (!min || a.fired_at < min) ? a.fired_at : min, null,
    );
    const started_at = firstAlertAt || inc.created_at;

    let ended_at: string | null = null;
    if (step === "resolved") {
      // Latest resolution timestamp
      const lastResolved = resolved.reduce<string | null>(
        (max, a) => (!max || (a.resolved_at || "") > max) ? a.resolved_at : max, null,
      );
      ended_at = inc.status === "resolved" || inc.status === "mitigated"
        ? (lastResolved && lastResolved > inc.updated_at ? lastResolved : inc.updated_at)
        : lastResolved;
    }

    workflows.push({
      id: `inc-${inc.id}`,
      kind: "incident",
      service_name: svcName || "unknown",
      service_tier: svc?.tier || "unknown",
      service_status: svc?.status || "unknown",
      step,
      firing_alerts: firing,
      resolved_alerts: resolved,
      incident: inc,
      confirmations: incConfs,
      started_at,
      ended_at,
      created_at: inc.created_at,
      updated_at: inc.updated_at,
    });
  }

  // 2) Untriaged workflows — firing alerts not yet attached to an OPEN incident
  //    (alerts whose only links are to closed incidents are "new" — they get a fresh workflow).
  const untriagedByService: Record<string, AlertWithService[]> = {};
  for (const a of alerts) {
    if (a.status !== "firing") continue;
    // The service already has an open incident — this alert is folded into that workflow.
    if (openIncidentServices.has(a.service_name)) continue;
    const linkedIncidents = (alertToIncidents[a.id] || []).map(id => incidentMap[id]).filter(Boolean);
    const hasOpenIncident = linkedIncidents.some(inc => !isClosed(inc));
    if (hasOpenIncident) continue;
    (untriagedByService[a.service_name] ||= []).push(a);
  }
  for (const [svcName, list] of Object.entries(untriagedByService)) {
    const svc = services.find(s => s.name === svcName);
    const started_at = list.reduce<string | null>((min, a) => (!min || a.fired_at < min) ? a.fired_at : min, null) ?? "";
    workflows.push({
      id: `svc-${svcName}-${started_at}`,
      kind: "pending",
      service_name: svcName,
      service_tier: svc?.tier || "unknown",
      service_status: svc?.status || "unknown",
      step: "detected",
      firing_alerts: list,
      resolved_alerts: [],
      incident: null,
      confirmations: [],
      started_at,
      ended_at: null,
      created_at: started_at,
      updated_at: started_at,
    });
  }

  // Sort: active first, then most recently started
  workflows.sort((a, b) => {
    const aActive = a.step !== "resolved" ? 0 : 1;
    const bActive = b.step !== "resolved" ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return (b.started_at || "").localeCompare(a.started_at || "");
  });

  return workflows;
}

// ── Autonomous triage reconciler ──
// Watches workflow state and dispatches directives to connected UIs:
//   • auto_investigate — a service has firing alerts but no incident yet
//   • auto_rca — an incident's alerts cleared with no approved remediation (external/auto resolution)
// Within-run guards (reset on restart — durability comes from re-deriving DB state).
const autoTriage = {
  investigated: new Set<string>(),
  executed: new Set<number>(),
  rca: new Set<number>(),         // final RCA task dispatched (remediated, or external fallback)
  rcaAsked: new Map<number, number>(), // incidentId → ts(ms) we asked the operator (external resolution)
};

// Bind the investigation thread (svc-<service>-<ts>) the agent is running under to the incident
// it just created (inc-N): alias it durably (so GET /api/chat replay surfaces the transcript
// under inc-N) and broadcast a live migration so connected UIs move the in-flight conversation —
// regardless of whether the incident's root-cause service matches the alerting service.
function linkInvestigationToIncident(investigationWid: string) {
  const row = db.query("SELECT id FROM incidents ORDER BY id DESC LIMIT 1").get() as { id: number } | null;
  if (!row) return;
  const incidentWid = `inc-${row.id}`;
  if (investigationWid === incidentWid) return;
  try {
    setThreadAlias(db, investigationWid, incidentWid);
    broadcast({ type: "thread_migrated", from: investigationWid, to: incidentWid });
    log("info", "triage", `Linked investigation thread ${investigationWid} → ${incidentWid}`);
  } catch (e) {
    log("warn", "triage", `Could not link investigation thread: ${getErrorMessage(e)}`);
  }
}

// Self-contained prompts — written so a fresh agent (e.g. after a restart) can act with
// only the ids/context embedded here, no prior conversation required.
function investigatePrompt(service: string, summary: string): string {
  const past = (db.query(`
    SELECT i.id, i.created_at, i.likely_cause, i.rca
    FROM incidents i
    JOIN services s ON s.id = i.root_cause_service_id
    WHERE i.status = 'resolved' AND s.name = ? AND i.rca IS NOT NULL
    ORDER BY i.created_at DESC LIMIT 3
  `).all(service) as Array<{ id: number; created_at: string; likely_cause: string | null; rca: string }>)
    .map(i => `- Incident #${i.id} (${i.created_at}): ${i.likely_cause ?? "unknown cause"} — ${i.rca}`)
    .join("\n");
  const history = past
    ? `\n\nPast resolved incidents where ${service} was the root cause (use for pattern recognition — verify current evidence before assuming same fix applies):\n${past}`
    : "";
  return `A new alert has fired for ${service}${summary ? `: ${summary}` : ""}. Investigate now without waiting: correlate the active alerts across services, check ${service} and its dependencies, review recent deployments and runbooks, then create an incident (create_incident) with a likely_cause and root_cause_service. Notify the channel, then propose the remediation step with request_confirmation and STOP — the operator approves in the UI. Do not execute remediation yourself.${history}`;
}
function executePrompt({ service, incidentId, confirmationId, action }: { service: string; incidentId: number; confirmationId: number; action: string }): string {
  return `The operator APPROVED the remediation for incident #${incidentId} (${service}) — confirmation #${confirmationId}${action ? `: "${action}"` : ""}. Execute it now by calling execute_runbook_step with incident_id ${incidentId}, confirmation_id ${confirmationId}, service "${service}", the step_id, and the command you proposed${action ? ` ("${action}")` : ""}. After it returns, briefly confirm what you ran and that the alerts are clearing.`;
}
// Remediation Argus ran itself — it knows the cause and the fix, so it writes the RCA directly.
function rcaRemediatedPrompt({ service, incidentId }: { service: string; incidentId: number }): string {
  return `Your approved remediation for ${service} (incident #${incidentId}) worked and the alerts cleared. Write a concise root-cause analysis — what failed, why, the fix applied, prevention/follow-up — and save it with update_incident (set rca, status resolved). You know the cause and fix, so don't ask. Do not propose further remediation.`;
}
// External/auto resolution — PHASE 1 of the human-in-the-loop RCA gate: research + ASK, then STOP
// and wait for the operator's reply. The agent must NOT write the RCA in this turn.
function rcaAskPrompt({ service, incidentId }: { service: string; incidentId: number }): string {
  return `The alerts for ${service} (incident #${incidentId}) cleared, but WITHOUT an approved remediation from Argus — it auto-healed or was fixed outside the system. Before writing any root-cause analysis, do these two things and then STOP:
1. Research what happened yourself: check ${service}'s health, recent deployments, and metric trends around the recovery.
2. Post a brief message to the operator — share your preliminary findings and ASK whether they know how it was resolved (a deploy, manual restart, config change, rollback, etc.).
Then end your turn and WAIT for the operator to reply. Do NOT call update_incident yet — you will write the combined RCA once they respond. Do not propose remediation; it is already resolved.`;
}
// External/auto resolution — PHASE 2 fallback: the operator never replied within the window, so
// write a research-only RCA rather than leaving the incident hanging without one.
function rcaFallbackPrompt({ service, incidentId }: { service: string; incidentId: number }): string {
  return `The operator hasn't responded about how incident #${incidentId} (${service}) was resolved, and the wait window has elapsed. Don't wait any longer: from your own research (service health, recent deployments, and metric trends around the recovery), write a concise root-cause analysis and save it with update_incident (set rca, status resolved). Note in the RCA that the operator did not confirm the resolution method. Do not propose remediation; it is already resolved.`;
}

// Reconcile desired autonomous actions from current DB state. Runs every tick and after
// restarts; the headless agent executes regardless of whether any UI is connected.
function reconcileTriage() {
  if (!serverAgent.session) return; // agent still booting

  let workflows: Workflow[];
  try {
    workflows = computeWorkflows();
  } catch (e) {
    log("warn", "triage", `reconcile failed: ${getErrorMessage(e)}`);
    return;
  }

  for (const wf of workflows) {
    // 1) Investigate: a fresh failure with no incident attached.
    if (wf.kind === "pending" && wf.firing_alerts.length > 0 && !autoTriage.investigated.has(wf.service_name)) {
      autoTriage.investigated.add(wf.service_name);
      const summary = wf.firing_alerts.map(a => `${a.metric_name} (${a.metric_value}/${a.threshold})`).join(", ");
      enqueueAgentTask({
        workflowId: wf.id,
        synthetic: true,
        label: `Auto-triage · investigating ${wf.service_name}`,
        prompt: investigatePrompt(wf.service_name, summary),
      });
      log("info", "triage", `Investigate enqueued for ${wf.service_name} [${wf.id}]`);
    }

    if (wf.kind === "incident" && wf.incident) {
      const inc = wf.incident;
      const approved = (wf.confirmations || []).find(c => c.status === "approved");

      // (The investigation transcript is linked to this incident at create_incident time via
      //  linkInvestigationToIncident — see the tool_execution_end handler.)

      // 2) Execute: approval on record, agent hasn't run the fix yet (not mitigated), alerts firing.
      //    Re-derivable after a restart → durable. Guarded once per confirmation per run.
      if (approved && inc.status !== "mitigated" && inc.status !== "resolved"
          && wf.firing_alerts.length > 0 && !autoTriage.executed.has(approved.id)) {
        autoTriage.executed.add(approved.id);
        enqueueAgentTask({
          workflowId: wf.id,
          synthetic: true,
          label: `Auto-triage · executing approved remediation on ${wf.service_name}`,
          prompt: executePrompt({ service: wf.service_name, incidentId: inc.id, confirmationId: approved.id, action: approved.action }),
        });
        log("info", "triage", `Execute enqueued for incident ${inc.id} (${wf.service_name}) [${wf.id}]`);
      }

      // 3) RCA: resolved incident with no RCA written yet.
      if (wf.step === "resolved" && !inc.rca) {
        if (approved) {
          // Argus ran the fix — write the RCA directly (single turn).
          if (!autoTriage.rca.has(inc.id)) {
            autoTriage.rca.add(inc.id);
            enqueueAgentTask({
              workflowId: wf.id,
              synthetic: true,
              label: `Auto-triage · ${wf.service_name} remediated — writing RCA`,
              prompt: rcaRemediatedPrompt({ service: wf.service_name, incidentId: inc.id }),
            });
            log("info", "triage", `RCA enqueued for incident ${inc.id} (${wf.service_name}, remediated) [${wf.id}]`);
          }
        } else if (!autoTriage.rcaAsked.has(inc.id)) {
          // External/auto resolution — PHASE 1: ask the operator how it was resolved, then WAIT.
          autoTriage.rcaAsked.set(inc.id, Date.now());
          enqueueAgentTask({
            workflowId: wf.id,
            synthetic: true,
            label: `Auto-triage · ${wf.service_name} resolved externally — asking operator`,
            prompt: rcaAskPrompt({ service: wf.service_name, incidentId: inc.id }),
          });
          log("info", "triage", `RCA ask enqueued for incident ${inc.id} (${wf.service_name}) — awaiting operator [${wf.id}]`);
        } else if (!autoTriage.rca.has(inc.id)
                   && Date.now() - (autoTriage.rcaAsked.get(inc.id) || 0) >= RCA_OPERATOR_TIMEOUT_MS) {
          // PHASE 2 fallback: no operator reply in the window → research-only RCA so it never hangs.
          // (If the operator did reply, the agent writes the RCA via update_incident — inc.rca is then
          //  set and this branch never runs.)
          autoTriage.rca.add(inc.id);
          enqueueAgentTask({
            workflowId: wf.id,
            synthetic: true,
            label: `Auto-triage · ${wf.service_name} — no operator reply, writing RCA from research`,
            prompt: rcaFallbackPrompt({ service: wf.service_name, incidentId: inc.id }),
          });
          log("info", "triage", `RCA fallback enqueued for incident ${inc.id} (${wf.service_name}, operator timeout) [${wf.id}]`);
        }
      }
    }
  }

  // Clear the investigate guard once a service is no longer pending so the NEXT failure re-triggers.
  const pending = new Set(workflows.filter(w => w.kind === "pending").map(w => w.service_name));
  for (const svc of [...autoTriage.investigated]) {
    if (!pending.has(svc)) autoTriage.investigated.delete(svc);
  }
}


async function handleConfirmationDecision(id: number, decision: string) {
  try {
    const conf = db.query("SELECT * FROM confirmations WHERE id = ?").get(id) as ConfirmationRow | null;
    if (!conf) return Response.json({ error: "Confirmation not found" }, { status: 404 });
    if (conf.status && conf.status !== "pending") {
      return Response.json({ error: `Confirmation already ${conf.status}` }, { status: 409 });
    }
    const newStatus = decision === "approve" ? "approved" : "declined";
    db.query("UPDATE confirmations SET status = ?, resolved_at = datetime('now') WHERE id = ?").run(newStatus, id);

    if (decision === "approve") {
      // The approval is now persisted (durable). The reconciler will pick it up within a
      // tick and enqueue the agent's execute_runbook_step — which works with no UI connected
      // and resumes after a restart. Approving alone already moves the workflow to the
      // "executing" stage (computeWorkflowStep: approved → executing).
      log("info", "confirm", `Approved confirmation ${id} — reconciler will dispatch execution for incident ${conf.incident_id}`);
    } else {
      log("info", "confirm", `Declined confirmation ${id}`);
      // Reflect the decision in the incident's chat thread — durable (survives refresh) and
      // broadcast live to connected UIs. The agent does not auto-react; it stays paused for
      // operator direction (the human is in the loop).
      const wid = `inc-${conf.incident_id}`;
      const note = `🚫 Operator declined the proposed fix${conf.action ? `: "${conf.action}"` : ""}. No remediation will run — the incident stays open pending operator direction.`;
      try { insertMessage(db, { thread_key: wid, role: "system", content: note, auto: 1 }); }
      catch (e) { log("warn", "confirm", `Could not persist decline note: ${getErrorMessage(e)}`); }
      broadcast({ type: "system_note", workflowId: wid, content: note });
    }

    return Response.json({ id, status: newStatus });
  } catch (err) {
    return Response.json({ error: getErrorMessage(err) }, { status: 500 });
  }
}

function handleClearResolved() {
  try {
    // Delete resolved alerts that have no incident link, or whose incidents are resolved/mitigated
    db.exec(`
      DELETE FROM alerts
      WHERE status = 'resolved'
        AND (
          id NOT IN (SELECT alert_id FROM incident_alerts)
          OR id IN (
            SELECT ia.alert_id FROM incident_alerts ia
            JOIN incidents i ON i.id = ia.incident_id
            WHERE i.status IN ('mitigated', 'resolved')
          )
        )
    `);
    // Also drop the chat transcripts for incidents that are now closed.
    deleteMessagesForClosedIncidents(db);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: getErrorMessage(err) }, { status: 500 });
  }
}

// ── Alertmanager webhook handler ──
// Alertmanager sends a notification like:
// {
//   "receiver": "argus-webhook",
//   "status": "firing",
//   "alerts": [
//     {
//       "status": "firing",
//       "labels": { "service": "pgsql", "severity": "critical", "alertname": "DBConnectionErrors" },
//       "annotations": { "summary": "...", "description": "..." },
//       "values": { "pgsql_connection_errors": 8.5 }  // only in newer versions
//     }
//   ],
//   ...groupLabels, commonLabels, commonAnnotations
// }

async function handleAlertmanagerWebhook(req: Request) {
  try {
    const body = await req.json() as any;
    const alerts = body.alerts || [];
    const results: { action: string; service: string; alert: string }[] = [];

    for (const alert of alerts) {
      const labels = alert.labels || {};
      const annotations = alert.annotations || {};
      const values = alert.values || alert.annotations?.values || {};
      const status = alert.status || body.status || "firing";

      const serviceName = labels.service;
      const alertName = labels.alertname;
      const severity = labels.severity || "warning";

      if (!serviceName) {
        log("warn", "alertmanager", `Skipping alert without service label: ${alertName || "unknown"}`);
        continue;
      }

      const svc = getService(db, serviceName);
      if (!svc) {
        log("warn", "alertmanager", `Skipping alert for unknown service: ${serviceName}`);
        continue;
      }

      // Try to extract metric value from annotations description or values
      let metricName = alertName || "unknown";
      const description = annotations.description || annotations.summary || `${serviceName}: ${metricName}`;
      let metricValue = 0;
      let threshold = 0;

      // Try to extract metric value from annotations description or values map
      // Alertmanager doesn't include values, but vmalert expands {{ $value }} in annotations.
      // Description format: "service metric is <value> (threshold: X)" or "service: metric is <value> (threshold: X)"
      if (values && typeof values === "object" && Object.keys(values).length > 0) {
        const valueEntries = Object.entries(values);
        metricName = valueEntries[0][0];
        metricValue = parseFloat(String(valueEntries[0][1])) || 0;
      } else {
        // Parse value from description: "... is <value> (threshold: X)" or "...: <value><unit> (threshold: X)"
        // Handles values like "0.75", "30000ms", "45s", "0.98"
        const valueMatch = description.match(/(?:is|:)\s*([\d.]+)(?:ms|s|%|ms)?\s*\(threshold/);
        if (valueMatch) {
          metricValue = parseFloat(valueMatch[1]) || 0;
        }
      }

      // Try to extract threshold from description pattern like "(threshold: X)"
      const thresholdMatch = description.match(/\(threshold:?\s*([\d.]+)(?:ms|s|%)?\)/);
      if (thresholdMatch) {
        threshold = parseFloat(thresholdMatch[1]) || 0;
      }

      if (status === "resolved") {
        // Resolve any matching firing alerts for this service + metric
        const existing = db.query(
          "SELECT * FROM alerts WHERE service_id = ? AND metric_name = ? AND status = 'firing'"
        ).all(svc.id, metricName) as { id: number }[];

        for (const row of existing) {
          resolveAlert(db, row.id);
          log("info", "alertmanager", `Resolved: ${serviceName} ${metricName}`);
        }

        // Update service status
        const firingCount = db.query(
          "SELECT COUNT(*) AS cnt FROM alerts WHERE service_id = ? AND status = 'firing'"
        ).get(svc.id) as { cnt: number };
        if (firingCount.cnt === 0) {
          db.query("UPDATE services SET status = 'healthy', last_checked = datetime('now') WHERE id = ?").run(svc.id);
        }

        results.push({ action: "resolved", service: serviceName, alert: metricName });
      } else {
        // Firing — create or update alert
        const existing = db.query(
          "SELECT * FROM alerts WHERE service_id = ? AND metric_name = ? AND status = 'firing'"
        ).get(svc.id, metricName) as AlertRow | null;

        if (existing) {
          db.query("UPDATE alerts SET metric_value = ?, severity = ?, message = ? WHERE id = ?")
            .run(metricValue, severity, description, existing.id);
          results.push({ action: "updated", service: serviceName, alert: metricName });
        } else if (isServiceInCooldown(db, svc.id, RECOVERY_COOLDOWN_SEC)) {
          // Post-recovery cooldown: vmalert evaluation lag can deliver a late FIRING
          // notification a cycle or two after the agent recovered the service. Suppressing
          // NEW alert creation here (same as the built-in scraper) prevents the orphan
          // "<service> Detected" workflow that arrives just after the incident closed.
          // Don't flip the service back to failing on a suppressed boundary reading.
          log("info", "alertmanager", `Suppressed (cooldown): ${serviceName} ${metricName}=${metricValue}`);
          results.push({ action: "suppressed", service: serviceName, alert: metricName });
          continue;
        } else {
          createAlert(db, {
            service_id: svc.id,
            severity,
            metric_name: metricName,
            metric_value: metricValue,
            threshold,
            message: description,
          });
          log("info", "alertmanager", `Alert: ${severity} ${serviceName} ${metricName}=${metricValue}`);
          results.push({ action: "created", service: serviceName, alert: metricName });
        }

        // Update service status
        db.query("UPDATE services SET status = 'failing', last_checked = datetime('now') WHERE id = ?").run(svc.id);
      }
    }

    log("info", "alertmanager", `Processed ${alerts.length} alert(s): ${results.map(r => `${r.action}:${r.service}/${r.alert}`).join(", ")}`);

    // No reflex ping here — createAlert/resolveAlert emit the deterministic FIRING/RESOLVED
    // ping at the single transition chokepoint (notifyAlertTransition), so it fires
    // identically under the built-in scraper and this webhook (and de-dupes across both).

    return Response.json({ processed: results.length, results }, { status: 200 });
  } catch (err) {
    log("error", "alertmanager", `Webhook processing failed: ${getErrorMessage(err)}`);
    return Response.json({ error: getErrorMessage(err) }, { status: 500 });
  }
}

// ── Direct webhook handler ──

async function handleCreateAlert(req: Request) {
  try {
    const body = await req.json() as any;
    const { service_name, severity, metric_name, metric_value, threshold, message } = body;

    if (!service_name || !metric_name || metric_value === undefined) {
      return Response.json({ error: "Missing required fields: service_name, metric_name, metric_value" }, { status: 400 });
    }

    const svc = getService(db, service_name);
    if (!svc) {
      return Response.json({ error: `Service "${service_name}" not found` }, { status: 404 });
    }

    const alert = createAlert(db, {
      service_id: svc.id,
      severity: severity || "warning",
      metric_name,
      metric_value,
      threshold: threshold || 0,
      message: message || `${service_name}: ${metric_name} is ${metric_value}`,
    });

    log("info", "webhook", `Alert created: ${service_name} ${metric_name}=${metric_value}`);
    return Response.json(alert, { status: 201 });
  } catch (err) {
    log("error", "webhook", `Alert creation failed: ${getErrorMessage(err)}`);
    return Response.json({ error: getErrorMessage(err) }, { status: 500 });
  }
}

// ── Client message handling ──

async function handleClientMessage(ws: ServerWebSocket<unknown>, raw: string | Buffer) {
  let payload: any;
  try {
    payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    throw new Error("Client message must be JSON.");
  }

  if (payload?.type === "switch_model") {
    await switchSessionModel(payload);
    return;
  }

  const message = payload?.message;
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error("Client message must include a non-empty message string.");
  }
  if (!serverAgent.session) throw new Error("Agent is still starting up.");

  const workflowId = typeof payload.workflowId === "string" ? payload.workflowId : null;
  const truncated = message.length > 120 ? `${message.slice(0, 120)}…` : message;
  log("info", "chat", `User [${workflowId || "?"}]: ${truncated}`);

  // User chat goes through the same shared agent. Not synthetic (the client already
  // echoed the user's bubble). No dedupe — every user message is intentional.
  enqueueAgentTask({ workflowId, prompt: message, synthetic: false });
}

async function switchSessionModel(payload: any) {
  const session = serverAgent.session;
  if (!session) throw new Error("Agent is still starting up.");
  if (serverAgent.busy) throw new Error("Cannot switch models while the agent is replying.");

  const provider = typeof payload.provider === "string" ? payload.provider : "ollama";
  const modelId = payload.model || payload.modelId;
  if (typeof modelId !== "string" || !modelId) {
    throw new Error("Model switch requires a model id.");
  }

  const model = session.modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Model not configured: ${provider}/${modelId}`);
  }

  log("info", "session", `Switching model to ${provider}/${modelId}`);
  await session.setModel(model);
  serverAgent.metadata = getSessionMetadata(session);
  broadcast({ type: "metadata", metadata: serverAgent.metadata });
}

// ── Helpers ──

function serveFileFromRoot(root: string, urlPath: string, fallbackToIndex: boolean): Response {
  if (!existsSync(root)) {
    return new Response(
      fallbackToIndex ? "Frontend has not been built. Run: cd argus-ui && bun run build" : "Not found",
      { status: fallbackToIndex ? 503 : 404 }
    );
  }

  const decodedPath = decodeURIComponent(urlPath.split("?")[0]);
  const relPath = decodedPath === "/" || decodedPath === "" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const requestedPath = resolve(root, normalize(relPath));
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;

  if (requestedPath !== root && !requestedPath.startsWith(rootWithSep)) {
    return new Response("Not found", { status: 404 });
  }

  let file = Bun.file(requestedPath);
  if (!file.size && fallbackToIndex) {
    file = Bun.file(join(root, "index.html"));
  }

  if (!file.size) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(file, {
    headers: { "Content-Type": contentType(file.name || requestedPath) },
  });
}

function send(ws: ServerWebSocket<unknown>, payload: unknown) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Socket already closed.
  }
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
