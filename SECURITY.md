# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem.

Use [GitHub's private vulnerability reporting](https://github.com/sdOps/argus/security/advisories/new) instead, from the repo's **Security** tab ("Report a vulnerability").
This opens a private advisory visible only to you and the maintainers, so the issue can be discussed and fixed before it's public.

We'll acknowledge a new report within a few days and follow up with next steps once we've assessed it.

## Scope

Argus is a headless agent that runs a server: argus-server exposes a REST API, a WebSocket, and a webhook receiver (Alertmanager alerts in), and it drives an LLM-backed agent that can call tools, including ones that execute remediation actions against the monitored stack.
The most relevant vulnerability classes here are things like: unauthenticated or under-authorized access to the API/WebSocket/webhook endpoints; a crafted alert or tool result that leads to prompt injection or an unintended tool call; secrets (LLM provider keys, webhook URLs) leaking via logs or responses; or a dependency with a known, reachable vulnerability (tracked via `bun audit`, see `.github/workflows/vulncheck.yml`).

## Supported versions

Argus is pre-1.0 and does not yet maintain multiple release branches.
Fixes land on `main`; there's no backport policy at this stage.
