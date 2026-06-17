// Resolve the base URL for a demo service's HTTP endpoints (/metrics, /recover, /fail).
//
// Two runtime topologies:
//   - Native (`mise run dev` / `mise run infra:start`): all six demo services run on
//     the same host, reachable at localhost:<port>.
//   - Docker Compose (`docker compose up`, with SERVICE_DNS=1): each demo service is its
//     own container, reachable by its compose service name — http://gateway:8081,
//     http://pgsql:8085, etc. The port stays the same; only the host changes.
const USE_DNS = process.env.SERVICE_DNS === "1";

export function serviceBaseUrl(svc: { name: string; port: number }): string {
  return `http://${USE_DNS ? svc.name : "localhost"}:${svc.port}`;
}
