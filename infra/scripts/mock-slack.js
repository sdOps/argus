/**
 * Mock Slack webhook server for Argus.
 *
 * Listens for incoming Slack webhook payloads on port 8090 and logs them
 * to stdout so you can inspect what Argus would send to a real Slack channel.
 *
 * Endpoints:
 *   POST /           — Slack webhook payload
 *   GET  /health     — Health check
 *   GET  /messages   — Recent messages (last 100)
 */

const PORT = Number(process.env.MOCK_SLACK_PORT || "8090");

const messages = [];

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok" });
    }

    // Recent messages
    if (url.pathname === "/messages" && req.method === "GET") {
      return Response.json({ messages, count: messages.length });
    }

    // Slack webhook
    if (url.pathname === "/" && req.method === "POST") {
      return handleSlackWebhook(req);
    }

    return new Response("Not found", { status: 404 });
  },
});

async function handleSlackWebhook(req) {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const entry = {
    timestamp: new Date().toISOString(),
    payload,
  };

  messages.push(entry);
  if (messages.length > 100) messages.shift();

  // Slack sends { text: "..." } or { blocks: [...] }
  const text = payload.text || payload.blocks?.map((b) => b.text?.text).join(" ") || JSON.stringify(payload);
  console.log(`📨 [${entry.timestamp}] ${text}`);

  return Response.json({ ok: true });
}

console.log(`Mock Slack server listening on http://localhost:${PORT}`);
console.log(`  POST /          — Slack webhook`);
console.log(`  GET  /health    — Health check`);
console.log(`  GET  /messages  — Recent messages`);