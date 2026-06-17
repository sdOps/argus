// app-ui.js — Mock frontend service (port 8082)
// Represents: React/Next.js frontend service

const PORT = 8082;
const SERVICE = "app-ui";

let failing = false;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/metrics" && req.method === "GET") {
      const assetFailures = failing ? 15 : 0;
      const ssrErrors = failing ? 1 : 0;
      const httpErrorRate = failing ? 0.80 : 0.01;
      return new Response(
        `# HELP appui_asset_load_failures Asset load failures\n` +
        `# TYPE appui_asset_load_failures gauge\n` +
        `appui_asset_load_failures ${assetFailures}\n\n` +
        `# HELP appui_ssr_errors SSR errors\n` +
        `# TYPE appui_ssr_errors gauge\n` +
        `appui_ssr_errors ${ssrErrors}\n\n` +
        `# HELP appui_http_error_rate HTTP error rate\n` +
        `# TYPE appui_http_error_rate gauge\n` +
        `appui_http_error_rate ${httpErrorRate}\n`,
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

console.log(`[app-ui] listening on :${PORT}`);