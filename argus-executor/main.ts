// Argus executor — tiny, hard-coded remediation worker.
//
// This service is the ONLY component that touches /var/run/docker.sock. It exposes a
// single POST /execute endpoint that accepts a typed { action, target } and runs only
// pre-approved actions against an allowlist of demo service containers. It validates on
// its own; it does not trust argus-server to decide what is safe.

const PORT = Number.parseInt(process.env.EXECUTOR_PORT || "3001", 10);
const DEFAULT_ALLOWLIST = ["gateway", "app-ui", "app-api", "auth", "pgsql", "redis"];
const ALLOWLIST = process.env.EXECUTOR_ALLOWLIST
  ? process.env.EXECUTOR_ALLOWLIST.split(",").map(s => s.trim()).filter(Boolean)
  : DEFAULT_ALLOWLIST;
const ALLOWSET = new Set(ALLOWLIST);

const DENYLIST = new Set(["argus-server", "argus-executor", "victoriametrics", "vmalert", "alertmanager", "mock-slack"]);

const ACTIONS = new Set(["restart"]);

type LogLevel = "info" | "warn" | "error";
function log(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
  const line = { ts: new Date().toISOString(), level, msg, ...extra };
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](JSON.stringify(line));
}

interface ExecuteRequest {
  action: string;
  target: string;
}

function isExecuteRequest(body: unknown): body is ExecuteRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.action === "string" && typeof b.target === "string";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runDocker(args: string[], timeoutMs = 60000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill("SIGTERM"), timeoutMs);
  try {
    const [stdoutBuf, stderrBuf] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).arrayBuffer()]);
    await proc.exited;
    return {
      ok: proc.exitCode === 0,
      stdout: new TextDecoder().decode(stdoutBuf).trim(),
      stderr: new TextDecoder().decode(stderrBuf).trim(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleExecute(body: ExecuteRequest): Promise<Response> {
  const { action, target } = body;

  if (!ACTIONS.has(action)) {
    log("warn", "rejected action", { action, target, reason: "action_not_allowed" });
    return jsonResponse({ error: `Action "${action}" is not allowed. Allowed actions: ${[...ACTIONS].join(", ")}` }, 400);
  }

  if (DENYLIST.has(target)) {
    log("warn", "rejected denylisted target", { action, target, reason: "target_denied" });
    return jsonResponse({ error: `Target "${target}" is explicitly denied.` }, 403);
  }

  if (!ALLOWSET.has(target)) {
    log("warn", "rejected target", { action, target, reason: "target_not_in_allowlist", allowlist: ALLOWLIST });
    return jsonResponse({ error: `Target "${target}" is not in the executor allowlist.` }, 403);
  }

  log("info", "executing remediation", { action, target });

  if (action === "restart") {
    const { ok, stdout, stderr } = await runDocker(["restart", target]);
    if (!ok) {
      log("error", "docker restart failed", { target, stderr, stdout });
      return jsonResponse({ error: `docker restart ${target} failed`, details: stderr || stdout }, 502);
    }
    log("info", "docker restart succeeded", { target, stdout });
    return jsonResponse({ action, target, status: "restarted", output: stdout });
  }

  // Unreachable — action was validated above.
  return jsonResponse({ error: "unexpected action" }, 500);
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok", allowlist: ALLOWLIST });
    }

    if (req.method !== "POST" || url.pathname !== "/execute") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }

    if (!isExecuteRequest(body)) {
      return jsonResponse({ error: "Request must be { action: string, target: string }" }, 400);
    }

    return handleExecute(body);
  },
});

log("info", "argus-executor listening", { port: PORT, allowlist: ALLOWLIST });
