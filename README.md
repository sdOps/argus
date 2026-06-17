# Argus — Agentic Incident Triage System

Autonomous incident triage agent. Monitors a demo microservices
stack and triages incidents before engineers are paged.

## Demo

<video src="https://github.com/user-attachments/assets/ebc290b8-bf4a-4389-aaf7-d931040b2a07" controls muted playsinline width="100%"></video>

*One incident, end to end: alert detection → autonomous investigation → proposed remediation → human approval → agent-executed recovery → root-cause analysis.*

## Architecture

**Demo stack (monitored):**

```
gateway → app-ui, app-api → auth, pgsql, redis
```

**Argus stack:**

- argus-server (Pi agent + webhook receiver)
- argus-ui (workflow-centric interface)
- VictoriaMetrics + vmalert + Alertmanager

## Built on

Argus is the system assembled around off-the-shelf foundations. It is not a from-scratch agent
framework. The original work is the operational control loop *around* the agent, not the harness.

- **[Pi](https://github.com/earendil-works/pi-coding-agent)** (`@earendil-works/pi-coding-agent`) —
  the agent harness. It runs the per-turn tool-calling loop (model → tool call → observe result →
  repeat) and session lifecycle; Argus registers its 12 triage tools with Pi and drives the
  sessions. Configured under `.pi/agent/`.
- **[Ollama](https://ollama.ai)** — serves the LLM the agent reasons with (local or cloud). It
  stays on the host, never in Docker.
- **[Bun](https://bun.sh)** — the runtime for the server and demo services; runs TypeScript
  directly with no build step.
- **[mise](https://mise.jdx.dev)** — the toolchain manager and task runner the whole repo is built
  around. It pins the tools (e.g. Bun), defines every `mise run …` task, and supplies the env vars,
  all from `mise.toml`. **You need mise installed to run anything here** (see Prerequisites).
- **[VictoriaMetrics](https://victoriametrics.com) + vmalert + Alertmanager** — the Prometheus-style
  metrics and alerting path (optional; the built-in scraper covers `mise run dev`).

## Quick start

There are three ways to run Argus. All three drive the same agent; they differ only
in *where* things run and *how alerts are generated*.

**1. Everything in Docker (one command) — best for reproducing the reference architecture:**

```bash
docker compose up --build      # 6 demo services + server + UI + VM/vmalert/Alertmanager
# or: mise run infra:up
```

Then open **http://localhost:3000** — under Docker, argus-server serves the UI single-origin
(app + API + live-chat WebSocket all on one port), so the live chat connects instantly with no
proxy in the way.

Make sure **Ollama is running on your host** first (see [Prerequisites](#prerequisites)) —
it is intentionally *not* in compose. The agent reaches it via `host.docker.internal:11434`.
Stop with `docker compose down` (or `mise run infra:down`).

**2. Hybrid (Docker observability + native services) — fast iteration with real Alertmanager:**

```bash
mise run install
mise run infra:start      # Docker: VM/vmalert/Alertmanager · native: services + server + UI
```

**3. Pure native (no Docker) — fastest inner loop, uses the built-in scraper:**

```bash
mise run install
mise run dev              # server + UI + services, with bun --watch hot-reload
```

> Modes 1 and 2 use the **Alertmanager** ingestion path (`DISABLE_SCRAPER=1`). Mode 3 uses
> the server's **built-in scraper**. See [How it works](#how-it-works).

## Demo scenarios

```bash
mise run infra:demo -- db       # database cascade
mise run infra:demo -- cache    # redis eviction storm
mise run infra:demo -- auth     # auth outage
mise run infra:demo -- all      # everything fails
mise run infra:demo -- recover  # restore all services
```

## URLs

| Service          | URL                          |
|------------------|------------------------------|
| Argus UI + API   | http://localhost:3000  (full Docker — UI served by argus-server) |
| Argus UI (native dev) | http://localhost:5173  (Vite dev server; API still :3000) |
| VictoriaMetrics  | http://localhost:8428/vmui   |
| Alertmanager     | http://localhost:9093        |
| vmalert          | http://localhost:8880        |
| Mock Slack       | http://localhost:8090        |

## Demo services

| Service | Port  | Tier       | Role                |
|---------|-------|------------|---------------------|
| gateway | 8081  | gateway    | nginx/envoy gateway |
| app-ui  | 8082  | frontend   | React/Next.js frontend |
| app-api | 8083  | backend    | Backend REST API    |
| auth    | 8084  | auth       | Auth service        |
| pgsql   | 8085  | database   | PostgreSQL database |
| redis   | 8086  | cache      | Redis cache         |

Each service exposes `GET /metrics` (Prometheus format), `POST /fail`, and `POST /recover`.

## Cascading failure scenarios

1. **Database cascade:** pgsql fails → app-api dependency errors → gateway upstream errors. Root cause: pgsql
2. **Auth outage:** auth fails → token validation errors → app-api 401s → gateway errors. Root cause: auth
3. **Cache eviction storm:** redis memory pressure → cache misses → app-api latency → pgsql pool exhaustion. Root cause: redis

## Prerequisites

- [mise](https://mise.jdx.dev) — **required**: it runs every `mise run …` command, pins the
  toolchain, and defines the env vars in `mise.toml`. Install it (`curl https://mise.run | sh`),
  then mise provisions the pinned tools automatically on first run.
- [Bun](https://bun.sh) (pinned via mise) — for native modes
- [Ollama](https://ollama.ai) running on the **host** with a pulled model. Use a
  **tool-calling, reasoning-capable** model — for example `qwen3.6`. Argus is model-agnostic;
  any equivalent works. Ollama stays outside Docker (it's host/GPU-bound and may point at a
  cloud model); the agent in the `argus-server` container reaches it at
  `host.docker.internal:11434`.
- OrbStack or Docker Desktop — required for the full Docker stack and the observability stack

> **Linux note:** the full-Docker stack maps `host.docker.internal` to the host gateway via
> `extra_hosts` in `docker-compose.yml`, so the agent → host-Ollama link works on Linux too.

**Model configuration.** Provider, model, and reasoning effort live in `.pi/agent/settings.json`
(`defaultProvider`, `defaultModel`, `defaultThinkingLevel`); per-model capabilities (the
`reasoning` flag, context window) live in `.pi/agent/models.json`. To point at a different
endpoint or model, set `OLLAMA_BASE_URL` / `OLLAMA_MODEL` and the model id there. Reasoning-capable
models honor `defaultThinkingLevel` (`low` / `medium` / `high`) — higher means more deliberation
per turn, at the cost of tokens and latency, both observable at `GET /metrics`. Cloud models
require Ollama auth; that credential file (`.pi/agent/auth.json`) is gitignored and never committed.

## How it works

**Alert flow (`docker compose up` / `mise run infra:start` — Alertmanager path):**

1. **VictoriaMetrics** scrapes demo service `/metrics` every 15 seconds
2. **vmalert** evaluates alerting rules against VictoriaMetrics
3. **Alertmanager** routes firing/resolved alerts to `POST /api/alerts/alertmanager`
4. **argus-server** creates and resolves alerts in the DB, updates service status
5. **Pi agent** investigates alerts and triages incidents

Under full Docker, every box above is a container on one compose network talking by
service DNS name (`argus-server:3000`, `gateway:8081`, …). Under `infra:start`, the
observability containers reach the native services via `host.docker.internal`.

**Alert flow (`mise run dev` — no Docker, built-in scraper):**

1. **argus-server** has a built-in scraper that polls `/metrics` directly every 15 seconds (enabled when `DISABLE_SCRAPER` is not set)

**Other components:**

- **Chat UI** — React interface with sidebar showing services, alerts, and incidents in real time
- **API** — REST endpoints at `/api/services`, `/api/alerts`, `/api/incidents`, `/api/deployments`

## Runbooks

Each monitored service has a YAML runbook in [`runbooks/services/`](runbooks/services/) that encodes
the operational knowledge an on-call engineer would reach for. A runbook declares:

- **`triggers`** — the metrics and thresholds that signal trouble (e.g. `pgsql_connection_pool_used > 0.90`).
- **`steps`** — ordered remediation steps, each typed `manual`, `executable` (with a `command`,
  `requires_confirmation`, and a `rollback`), or `notify` (escalate to a channel).
- **`known_patterns`** — named failure patterns that map a cluster of symptoms to a **root cause**.
  This is what lets the agent resolve a multi-service cascade to the one service actually at fault.
- **`related_runbooks`** — links to dependent services' runbooks.

The agent reads them through the `search_runbooks` tool. The `known_patterns` are the highest-value
part: when several services alert at once, a pattern like this is how the agent reasons past the
symptoms to the cause.

```yaml
# runbooks/services/pgsql.yaml (excerpt)
known_patterns:
  - name: "Database failure cascade"
    description: >
      pgsql connection errors and query timeouts cause app-api dependency_errors
      to spike, which raises app-api http_error_rate, which increases gateway
      upstream_error_rate. The most common cascading failure pattern.
    root_cause: pgsql

  - name: "Cache eviction storm (secondary)"
    description: >
      When redis cache hit rate collapses, direct pgsql queries increase, filling
      the connection pool. pgsql appears to be the problem, but the actual root
      cause is redis memory pressure causing cache misses.
    root_cause: redis
```

These runbooks are curated, human-authored knowledge the agent consults. The model does not invent them at runtime.

## Agent tools

| Tool | Description |
|------|-------------|
| `get_alert` | Get details of a specific alert |
| `list_active_alerts` | List all currently firing alerts |
| `check_service_health` | Scrape live metrics from a service |
| `create_incident` | Create an incident with triage findings |
| `update_incident` | Update incident status or root cause |
| `list_incidents` | List incidents by status |
| `search_runbooks` | Search runbooks by service or keyword |
| `get_recent_deployments` | Check recent deployments |
| `notify_channel` | Send notification to a Slack channel |
| `request_confirmation` | Request human approval before remediation |
| `execute_runbook_step` | Execute a remediation step after confirmation |

## All mise tasks

| Task | Description |
|------|-------------|
| `mise run install` | Install all dependencies |
| `mise run dev` | Start server + UI + services (native, no Docker) |
| `mise run services` | Start demo microservices only |
| `mise run demo` | Alias for `mise run services` |
| `mise run clean` | Remove node_modules and databases |
| `mise run infra:up` | Start the **full Docker stack** (compose: services + server + UI + observability) |
| `mise run infra:down` | Stop the full Docker stack (`-- -v` also drops volumes) |
| `mise run infra:start` | Start hybrid stack (Docker observability + native services/server/UI) |
| `mise run infra:stop` | Stop the hybrid stack |
| `mise run infra:demo -- <scenario>` | Trigger a demo failure scenario (works in any mode) |

> `infra:up`/`infra:down` wrap `docker compose` on the top-level `docker-compose.yml`.
> The infra-only observability stack (for use with native services) remains
> `infra/docker-compose.yml`, driven by `mise run infra:start`/`infra:stop`.