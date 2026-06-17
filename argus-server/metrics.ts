// Self-observability: Prometheus exposition for the headless agent's own model usage.
//
// Argus already scrapes the six demo services' /metrics through VictoriaMetrics; this
// makes the agent a monitored service in its own stack. The deterministic side of the
// system (detection, triggering) is controlled by construction; the agentic side is
// non-deterministic, so we instrument it instead — tokens, cost, latency, tool calls.
//
// Cumulative token/cost/tool totals come for free from session.getSessionStats() at
// scrape time. This in-process accumulator covers what stats doesn't: turn count,
// per-tool-name breakdown, turn latency, prompt errors.
//
// NOTE: all counters live in process memory and reset on server restart / `bun --watch`
// reload (the in-memory Pi session resets too). That's expected for a process-level
// exporter — Prometheus/VictoriaMetrics handle counter resets natively.

interface SessionStatsLike {
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}

// Minimal structural view of ServerAgentState (avoids a circular import with server.ts).
interface AgentStateLike {
  session: { getSessionStats(): SessionStatsLike } | null;
  metadata: { model?: string; provider?: string } | null;
  queue: { length: number };
  busy: boolean;
}

export const agentMetrics = {
  turns: 0,
  errors: 0,
  toolCalls: {} as Record<string, number>,
  lastTurnMs: 0,
  turnDurationSumMs: 0,
};

export function recordToolCall(tool: string): void {
  agentMetrics.toolCalls[tool] = (agentMetrics.toolCalls[tool] || 0) + 1;
}

export function recordTurn(durationMs: number): void {
  agentMetrics.turns += 1;
  agentMetrics.lastTurnMs = durationMs;
  agentMetrics.turnDurationSumMs += durationMs;
}

export function recordError(): void {
  agentMetrics.errors += 1;
}

// Escape a Prometheus label value (backslash, double-quote, newline) per the exposition format.
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function metric(name: string, type: "counter" | "gauge", help: string, lines: string[]): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${lines.join("\n")}\n`;
}

// Render the full Prometheus exposition. Safe to call before the agent has booted
// (null session → zeroed token/cost counters).
export function renderMetrics(agent: AgentStateLike): string {
  const stats = agent.session?.getSessionStats();
  const tokens = stats?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const cost = stats?.cost ?? 0;

  const blocks: string[] = [];

  blocks.push(metric("argus_agent_info", "gauge", "Agent model/provider build info", [
    `argus_agent_info{model="${esc(agent.metadata?.model || "unknown")}",provider="${esc(agent.metadata?.provider || "unknown")}"} 1`,
  ]));

  blocks.push(metric("argus_agent_turns_total", "counter", "Completed agent turns", [
    `argus_agent_turns_total ${agentMetrics.turns}`,
  ]));

  blocks.push(metric("argus_agent_tokens_input_total", "counter", "Prompt (input) tokens consumed", [
    `argus_agent_tokens_input_total ${tokens.input}`,
  ]));
  blocks.push(metric("argus_agent_tokens_output_total", "counter", "Completion (output) tokens produced", [
    `argus_agent_tokens_output_total ${tokens.output}`,
  ]));
  blocks.push(metric("argus_agent_tokens_cache_read_total", "counter", "Cache-read tokens", [
    `argus_agent_tokens_cache_read_total ${tokens.cacheRead}`,
  ]));
  blocks.push(metric("argus_agent_tokens_cache_write_total", "counter", "Cache-write tokens", [
    `argus_agent_tokens_cache_write_total ${tokens.cacheWrite}`,
  ]));
  blocks.push(metric("argus_agent_tokens_total", "counter", "Total tokens (input+output+cache)", [
    `argus_agent_tokens_total ${tokens.total}`,
  ]));

  blocks.push(metric("argus_agent_cost_usd_total", "counter", "Cumulative model cost in USD", [
    `argus_agent_cost_usd_total ${cost}`,
  ]));

  const toolLines = Object.entries(agentMetrics.toolCalls).map(
    ([tool, n]) => `argus_agent_tool_calls_total{tool="${esc(tool)}"} ${n}`,
  );
  blocks.push(metric("argus_agent_tool_calls_total", "counter", "Tool calls by tool name",
    toolLines.length ? toolLines : ["# (no tool calls yet)"]));

  blocks.push(metric("argus_agent_turn_duration_ms_sum", "counter", "Sum of agent turn durations (ms)", [
    `argus_agent_turn_duration_ms_sum ${agentMetrics.turnDurationSumMs}`,
  ]));
  blocks.push(metric("argus_agent_turn_duration_ms_count", "counter", "Count of timed agent turns", [
    `argus_agent_turn_duration_ms_count ${agentMetrics.turns}`,
  ]));
  blocks.push(metric("argus_agent_turn_last_ms", "gauge", "Duration of the most recent agent turn (ms)", [
    `argus_agent_turn_last_ms ${agentMetrics.lastTurnMs}`,
  ]));

  blocks.push(metric("argus_agent_errors_total", "counter", "Failed agent prompts", [
    `argus_agent_errors_total ${agentMetrics.errors}`,
  ]));
  blocks.push(metric("argus_agent_queue_depth", "gauge", "Pending tasks in the agent queue", [
    `argus_agent_queue_depth ${agent.queue.length}`,
  ]));
  blocks.push(metric("argus_agent_busy", "gauge", "1 while the agent is processing a turn", [
    `argus_agent_busy ${agent.busy ? 1 : 0}`,
  ]));

  return blocks.join("\n");
}
