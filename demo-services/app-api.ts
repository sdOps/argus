// app-api.js — Mock backend API service (port 8083)
// Represents: Backend REST API service

const PORT = 8083;
const SERVICE = "app-api";

let failing = false;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/metrics" && req.method === "GET") {
      const httpErrorRate = failing ? 0.85 : 0.01;
      const latencyP99 = failing ? 5000 : 80;
      const dependencyErrors = failing ? 22 : 0;
      return new Response(
        `# HELP appapi_http_error_rate HTTP error rate\n` +
        `# TYPE appapi_http_error_rate gauge\n` +
        `appapi_http_error_rate ${httpErrorRate}\n\n` +
        `# HELP appapi_latency_p99_ms P99 latency in milliseconds\n` +
        `# TYPE appapi_latency_p99_ms gauge\n` +
        `appapi_latency_p99_ms ${latencyP99}\n\n` +
        `# HELP appapi_dependency_errors Dependency call errors\n` +
        `# TYPE appapi_dependency_errors gauge\n` +
        `appapi_dependency_errors ${dependencyErrors}\n`,
        { headers: { "Content-Type": "text/plain; version=0.0.4" } }
      );
    }

    if (url.pathname === "/fail" && req.method === "POST") {
      failing = true;
      return Response.json({ service: SERVICE, status: "failing" });
    }

    if (url.pathname === "/recover" && req.method === "POST") {
      failing = false;
      return Response.json({ service: SERVICE, status: "healthy" });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[app-api] listening on :${PORT}`);