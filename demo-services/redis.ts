// redis.js — Mock Redis cache service (port 8086)
// Represents: Redis cache layer

const PORT = 8086;
const SERVICE = "redis";

let failing = false;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/metrics" && req.method === "GET") {
      const connectionErrors = failing ? 8 : 0;
      const memoryUsedRatio = failing ? 0.97 : 0.45;
      const cacheHitRate = failing ? 0.10 : 0.92;
      const evictedKeys = failing ? 3400 : 0;
      return new Response(
        `# HELP redis_connection_errors Connection errors\n` +
        `# TYPE redis_connection_errors gauge\n` +
        `redis_connection_errors ${connectionErrors}\n\n` +
        `# HELP redis_memory_used_ratio Memory used ratio\n` +
        `# TYPE redis_memory_used_ratio gauge\n` +
        `redis_memory_used_ratio ${memoryUsedRatio}\n\n` +
        `# HELP redis_cache_hit_rate Cache hit rate\n` +
        `# TYPE redis_cache_hit_rate gauge\n` +
        `redis_cache_hit_rate ${cacheHitRate}\n\n` +
        `# HELP redis_evicted_keys Evicted keys\n` +
        `# TYPE redis_evicted_keys gauge\n` +
        `redis_evicted_keys ${evictedKeys}\n`,
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

console.log(`[redis] listening on :${PORT}`);