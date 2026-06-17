// gateway.js — Mock gateway service (port 8081)
// Represents: nginx/envoy gateway tier

const PORT = 8081;
const SERVICE = "gateway";

let failing = false;
let requestCount = 0;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/metrics" && req.method === "GET") {
      requestCount++;
      const upstreamErrorRate = failing ? 0.90 : 0.01;
      const latencyP99 = failing ? 8000 : 45;
      return new Response(
        `# HELP gateway_upstream_error_rate Upstream error rate\n` +
        `# TYPE gateway_upstream_error_rate gauge\n` +
        `gateway_upstream_error_rate ${upstreamErrorRate}\n\n` +
        `# HELP gateway_latency_p99_ms P99 latency in milliseconds\n` +
        `# TYPE gateway_latency_p99_ms gauge\n` +
        `gateway_latency_p99_ms ${latencyP99}\n\n` +
        `# HELP gateway_requests_total Total requests\n` +
        `# TYPE gateway_requests_total counter\n` +
        `gateway_requests_total ${requestCount}\n`,
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

console.log(`[gateway] listening on :${PORT}`);