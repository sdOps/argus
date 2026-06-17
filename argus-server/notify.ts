// Deterministic "reflex" Slack ping.
//
// Principle (see ARCHITECTURE.md §7): the agent is the *narrator*, never the *smoke
// detector*. The instant FIRING/RESOLVED ping is mechanical, must-always-happen code —
// it must never depend on the agent being up/fast/correct. It is emitted at the single
// chokepoint where an alert transitions firing/resolved (createAlert / resolveAlert in
// db/api.ts), so it fires identically under the built-in scraper (`mise run dev`) and the
// Alertmanager webhook (`mise run infra:start`).
//
// The agent's `notify_channel` is the *narration* layer (incident + root-cause theory),
// labelled "🤖 Argus" so a human can tell a measured fact from the agent's interpretation.

const SYSTEM_LABEL = "[Argus·system]";

// Short de-dup window so the same transition pinged by two ingestion paths (scraper AND
// Alertmanager both somehow active) collapses to one message. Row-level guards in the
// scraper/webhook already prevent most doubles; this is a cheap belt-and-suspenders.
const DEDUPE_WINDOW_MS = 8_000;
const recentPings = new Map<string, number>();

export interface AlertTransition {
  type: "firing" | "resolved";
  service: string;
  metric: string;
}

export function notifyAlertTransition(t: AlertTransition): void {
  const key = `${t.type}:${t.service}:${t.metric}`;
  const now = Date.now();
  const last = recentPings.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
  recentPings.set(key, now);
  // Opportunistically prune so the map can't grow unbounded over a long run.
  if (recentPings.size > 256) {
    for (const [k, ts] of recentPings) {
      if (now - ts >= DEDUPE_WINDOW_MS) recentPings.delete(k);
    }
  }
  // Fire-and-forget: the DB write is the source of truth; the ping must never block or
  // fail an alert transition.
  void postReflexPing(t).catch(() => { /* best effort */ });
}

async function postReflexPing({ type, service, metric }: AlertTransition): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL || process.env.MOCK_SLACK_URL;
  if (!webhookUrl) return;

  const emoji = type === "firing" ? "🔴" : "✅";
  const label = type === "firing" ? "FIRING" : "RESOLVED";
  const text = `${SYSTEM_LABEL} ${emoji} *${label}* — ${service}/${metric}`;

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "#incidents", text }),
  });
  if (!resp.ok) {
    console.warn(`${new Date().toISOString()} [WARN] [slack] reflex ping failed: ${resp.status}`);
  }
}
