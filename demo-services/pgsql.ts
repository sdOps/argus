// pgsql.js — Mock PostgreSQL database (port 8085)
// Represents: PostgreSQL database

const PORT = 8085;
const SERVICE = "pgsql";

let failing = false;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/metrics" && req.method === "GET") {
      const connectionErrors = failing ? 18 : 0;
      const queryDurationP99 = failing ? 30000 : 12;
      const connectionPoolUsed = failing ? 0.98 : 0.30;
      const replicationLag = failing ? 45 : 0;
      return new Response(
        `# HELP pgsql_connection_errors Connection errors\n` +
        `# TYPE pgsql_connection_errors gauge\n` +
        `pgsql_connection_errors ${connectionErrors}\n\n` +
        `# HELP pgsql_query_duration_p99_ms P99 query duration in milliseconds\n` +
        `# TYPE pgsql_query_duration_p99_ms gauge\n` +
        `pgsql_query_duration_p99_ms ${queryDurationP99}\n\n` +
        `# HELP pgsql_connection_pool_used Connection pool utilization\n` +
        `# TYPE pgsql_connection_pool_used gauge\n` +
        `pgsql_connection_pool_used ${connectionPoolUsed}\n\n` +
        `# HELP pgsql_replication_lag_seconds Replication lag in seconds\n` +
        `# TYPE pgsql_replication_lag_seconds gauge\n` +
        `pgsql_replication_lag_seconds ${replicationLag}\n`,
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

console.log(`[pgsql] listening on :${PORT}`);