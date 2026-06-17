// auth.js — Mock authentication service (port 8084)
// Represents: Authentication/authorization service

const PORT = 8084;
const SERVICE = "auth";

let failing = false;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/metrics" && req.method === "GET") {
      const tokenValidationErrors = failing ? 120 : 0;
      const loginFailures = failing ? 95 : 2;
      const sessionErrors = failing ? 40 : 0;
      return new Response(
        `# HELP auth_token_validation_errors Token validation errors\n` +
        `# TYPE auth_token_validation_errors gauge\n` +
        `auth_token_validation_errors ${tokenValidationErrors}\n\n` +
        `# HELP auth_login_failures Login failures\n` +
        `# TYPE auth_login_failures gauge\n` +
        `auth_login_failures ${loginFailures}\n\n` +
        `# HELP auth_session_errors Session errors\n` +
        `# TYPE auth_session_errors gauge\n` +
        `auth_session_errors ${sessionErrors}\n`,
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

console.log(`[auth] listening on :${PORT}`);