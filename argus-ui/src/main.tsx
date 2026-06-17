import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import type { Alert, Incident, Confirmation, Service, Workflow, WorkflowStep, ChatMsg, Metadata, SocketApi, IconProps } from "./types.ts";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import javascript from "highlight.js/lib/languages/javascript";
import "highlight.js/styles/github-dark-dimmed.css";
import "./styles.css";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);

marked.setOptions({
  gfm: true,
  breaks: true,
  highlight: (code: string, lang: string) => {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    } catch {}
    return code;
  },
} as any);

function renderMarkdown(text: string): string {
  try { return marked.parse(text || "") as string; }
  catch { return text; }
}

// ─────────────────────────── Workflow model ───────────────────────────

const WORKFLOW_STEPS = [
  { id: "detected",      label: "Detected",      desc: "Alert fired" },
  { id: "investigating", label: "Investigating", desc: "Agent gathering signals" },
  { id: "root_cause",    label: "Root Cause",    desc: "Cause identified" },
  { id: "remediation",   label: "Remediation",   desc: "Fix proposed" },
  { id: "confirmation",  label: "Approval",      desc: "Awaiting human approval" },
  { id: "executing",     label: "Executing",     desc: "Running remediation" },
  { id: "verifying",    label: "Verifying",     desc: "Confirming service health" },
  { id: "resolved",      label: "Resolved",      desc: "All clear" },
];
const stepIndex = (id: string): number => WORKFLOW_STEPS.findIndex(s => s.id === id);

// ─────────────────────────── Icons (heroicons-inspired) ───────────────────────────

const Icon = ({ d, size = 16, className = "", strokeWidth = 1.6, style }: IconProps & { d: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    {d}
  </svg>
);
const IconEye        = (p: IconProps) => <Icon {...p} d={<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></>} />;
const IconChat       = (p: IconProps) => <Icon {...p} d={<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>} />;
const IconCheck      = (p: IconProps) => <Icon {...p} d={<path d="M20 6L9 17l-5-5"/>} />;
const IconX          = (p: IconProps) => <Icon {...p} d={<><path d="M18 6L6 18"/><path d="M6 6l12 12"/></>} />;
const IconClose      = IconX;
const IconSend       = (p: IconProps) => <Icon {...p} d={<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>} />;
const IconAlert      = (p: IconProps) => <Icon {...p} d={<><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>} />;
const IconSearch     = (p: IconProps) => <Icon {...p} d={<><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></>} />;
const IconTarget     = (p: IconProps) => <Icon {...p} d={<><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></>} />;
const IconWrench     = (p: IconProps) => <Icon {...p} d={<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>} />;
const IconClock      = (p: IconProps) => <Icon {...p} d={<><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>} />;
const IconPlay       = (p: IconProps) => <Icon {...p} d={<polygon points="5 3 19 12 5 21 5 3"/>} />;
const IconShield     = (p: IconProps) => <Icon {...p} d={<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>} />;
const IconSparkle    = (p: IconProps) => <Icon {...p} d={<><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></>} />;
const IconTrash      = (p: IconProps) => <Icon {...p} d={<><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></>} />;
const IconChevron    = (p: IconProps) => <Icon {...p} d={<polyline points="9 18 15 12 9 6"/>} />;

function stepIcon(stepId: string, props: IconProps = {}) {
  switch (stepId) {
    case "detected":      return <IconAlert    {...props} />;
    case "investigating": return <IconSearch   {...props} />;
    case "root_cause":    return <IconTarget   {...props} />;
    case "remediation":   return <IconWrench   {...props} />;
    case "confirmation":  return <IconClock    {...props} />;
    case "executing":     return <IconPlay     {...props} />;
    case "verifying":     return <IconEye      {...props} />;
    case "resolved":      return <IconCheck    {...props} />;
    default:              return <IconAlert    {...props} />;
  }
}

// ─────────────────────────── Shared WS hook ───────────────────────────
// The agent runs entirely server-side. This socket just *displays* its streamed output
// (every message is tagged with a workflowId) and sends the operator's chat input.

function useArgusSocket() {
  const [status, setStatus] = useState("connecting");
  const [chats, setChats] = useState<Record<string, ChatMsg[]>>({}); // { workflowId: [messages] }
  const [activeWid, setActiveWid] = useState<string | null>(null);
  const [toolByWid, setToolByWid] = useState<Record<string, string>>({}); // { workflowId: "Querying logs…" }
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  // svc-thread → inc-thread remaps announced by the server (thread_migrated). Used to route
  // incoming events for the old id to the incident thread, and to redirect selection (App).
  const [migrations, setMigrations] = useState<Record<string, string>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const activeWidRef = useRef<string | null>(null);
  const aliasRef = useRef<Record<string, string>>({});

  useEffect(() => { activeWidRef.current = activeWid; }, [activeWid]);

  // Load the durable transcript FIRST, then open the WS. Sequencing them this way means
  // history is in place before any live message arrives — no snapshot/stream race on refresh.
  useEffect(() => {
    let ws: WebSocket | undefined;
    let cancelled = false;

    type HistoryMsg = { role: ChatMsg["role"]; content: string; auto?: boolean };
    const applyHistory = (threads: Record<string, HistoryMsg[]> | undefined) => {
      if (!threads) return;
      setChats(c => {
        const next = { ...c };
        for (const [wid, msgs] of Object.entries(threads)) {
          if (next[wid] && next[wid].length) continue; // don't clobber a live thread
          next[wid] = msgs.map(m => ({
            id: crypto.randomUUID(), role: m.role, content: m.content, auto: !!m.auto, streaming: false,
          }));
        }
        return next;
      });
    };

    const handleMessage = (e: MessageEvent) => {
      let p: any; try { p = JSON.parse(e.data); } catch { return; }

      // The server bound an investigation thread to its incident — move the conversation and
      // route any further events for the old id (the agent's turn keeps streaming under it).
      if (p.type === "thread_migrated") {
        if (p.from && p.to && p.from !== p.to) {
          aliasRef.current[p.from] = p.to;
          migrateChat(p.from, p.to);
          setMigrations(m => ({ ...m, [p.from]: p.to }));
        }
        return;
      }

      let wid: string | null = p.workflowId || activeWidRef.current;
      if (wid && aliasRef.current[wid]) wid = aliasRef.current[wid]; // follow svc→inc remap

      if (p.type === "ready")    { setStatus("ready"); if (p.metadata) setMetadata(p.metadata); return; }
      if (p.type === "metadata") { if (p.metadata) setMetadata(p.metadata); return; }

      // Mid-stream reconnect: seed the in-progress agent bubble with the partial so far.
      if (p.type === "agent_seed") {
        if (!wid || !p.content) return;
        setChats(c => {
          const list = c[wid] ? [...c[wid]] : [];
          const last = list[list.length - 1];
          if (last && last.role === "agent" && last.streaming) {
            list[list.length - 1] = { ...last, content: p.content };
          } else {
            list.push({ id: crypto.randomUUID(), role: "agent", content: p.content, streaming: true });
          }
          return { ...c, [wid]: list };
        });
        return;
      }

      // Server-initiated autonomous task — show a synthetic chip + open an agent bubble.
      if (p.type === "agent_prompt") {
        if (!wid) return;
        setChats(c => {
          const prev = (c[wid] || []).map(m => ({ ...m, streaming: false }));
          return { ...c, [wid]: [
            ...prev,
            { id: crypto.randomUUID(), role: "user", content: p.label || "Auto-triage", auto: true },
            { id: crypto.randomUUID(), role: "agent", content: "", streaming: true },
          ] };
        });
        return;
      }

      // Server-side note (e.g. operator declined a fix) — append as a system line to the thread.
      if (p.type === "system_note") {
        if (!wid || !p.content) return;
        setChats(c => ({ ...c, [wid]: [
          ...(c[wid] || []).map(m => ({ ...m, streaming: false })),
          { id: crypto.randomUUID(), role: "system", content: p.content },
        ] }));
        return;
      }

      if (p.type === "thinking") return; // raw reasoning is never displayed
      if (p.type === "tool_start") { if (wid) setToolByWid(m => ({ ...m, [wid]: toolLabel(p.name) })); return; }
      if (p.type === "tool_end")   { if (wid) setToolByWid(m => { const n = { ...m }; delete n[wid]; return n; }); return; }

      if (p.type === "text") {
        if (!wid) return;
        setChats(c => {
          const list = c[wid] ? [...c[wid]] : [];
          const last = list[list.length - 1];
          if (!last || last.role !== "agent" || !last.streaming) {
            list.push({ id: crypto.randomUUID(), role: "agent", content: p.delta || "", streaming: true });
          } else {
            list[list.length - 1] = { ...last, content: last.content + (p.delta || "") };
          }
          return { ...c, [wid]: list };
        });
        return;
      }
      if (p.type === "done") {
        if (p.metadata) setMetadata(p.metadata);
        if (wid) {
          setToolByWid(m => { const n = { ...m }; delete n[wid]; return n; });
          setChats(c => ({ ...c, [wid]: (c[wid] || []).map(m => ({ ...m, streaming: false })) }));
        }
        return;
      }
      if (p.type === "error") {
        if (wid) {
          setToolByWid(m => { const n = { ...m }; delete n[wid]; return n; });
          setChats(c => ({ ...c, [wid]: [...(c[wid] || []), { id: crypto.randomUUID(), role: "system", content: p.message || "Error" }] }));
        }
      }
    };

    const openSocket = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;
      ws.addEventListener("open",  () => setStatus("connected"));
      ws.addEventListener("close", () => { setStatus("disconnected"); setToolByWid({}); });
      ws.addEventListener("error", () => setStatus("error"));
      ws.addEventListener("message", handleMessage);
    };

    fetch("/api/chat")
      .then(r => r.json())
      .then(({ threads }) => applyHistory(threads))
      .catch(() => {})
      .finally(openSocket);

    return () => { cancelled = true; if (ws) ws.close(); };
  }, []);

  const send = useCallback((wid: string, message: string, service?: string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    setActiveWid(wid);
    activeWidRef.current = wid;
    ws.send(JSON.stringify({ workflowId: wid, service, message }));
    setChats(c => {
      const prev = (c[wid] || []).map(m => ({ ...m, streaming: false }));
      return {
        ...c,
        [wid]: [
          ...prev,
          { id: crypto.randomUUID(), role: "user", content: message },
          { id: crypto.randomUUID(), role: "agent", content: "", streaming: true },
        ],
      };
    });
    return true;
  }, []);

  // Move conversation from one workflow id to another (e.g. pending svc-X superseded by inc-N)
  const migrateChat = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    setChats(c => {
      if (!c[fromId]) return c;
      const next = { ...c };
      next[toId] = [...(c[toId] || []), ...c[fromId]];
      delete next[fromId];
      return next;
    });
    if (activeWidRef.current === fromId) {
      activeWidRef.current = toId;
      setActiveWid(toId);
    }
  }, []);

  return { status, chats, toolByWid, metadata, send, migrateChat, migrations };
}

// ─────────────────────────── Main App ───────────────────────────

function App() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const socket = useArgusSocket();

  const pollOnce = useCallback(async () => {
    try {
      const [wRes, sRes] = await Promise.all([fetch("/api/workflows"), fetch("/api/services")]);
      if (wRes.ok) setWorkflows((await wRes.json()).workflows as Workflow[]);
      if (sRes.ok) setServices((await sRes.json()).services as Service[]);
    } catch {}
  }, []);

  useEffect(() => {
    pollOnce();
    const t = setInterval(pollOnce, 3000);
    return () => clearInterval(t);
  }, [pollOnce]);

  // Follow workflow handoffs: if the selected id disappears (e.g. pending svc-pgsql-X gets
  // superseded by inc-2 once the agent creates the incident), forward selection AND chat
  // history to the successor so the conversation continues seamlessly.
  useEffect(() => {
    if (workflows.length === 0) return;
    if (selectedId && workflows.some(w => w.id === selectedId)) return;

    let nextId = null;
    if (selectedId && selectedId.startsWith("svc-")) {
      // Prefer the server-announced remap (handles cascades where the incident's root-cause
      // service differs from the alerting service); fall back to same-service matching.
      const mapped = socket.migrations[selectedId];
      const svcName = selectedId.split("-")[1];
      const successor = (mapped && workflows.find(w => w.id === mapped))
        || workflows.find(w => w.kind === "incident" && w.service_name === svcName && w.step !== "resolved");
      if (successor) {
        nextId = successor.id;
        socket.migrateChat(selectedId, successor.id);
      }
    }
    if (!nextId) {
      const firstActive = workflows.find(w => w.step !== "resolved");
      nextId = (firstActive || workflows[0]).id;
    }
    setSelectedId(nextId);
  }, [workflows, selectedId, socket]);

  const selected = workflows.find(w => w.id === selectedId) || null;

  const clearResolved = async () => {
    await fetch("/api/workflows/clear", { method: "POST" });
    pollOnce();
  };

  return (
    <div className="flex h-screen text-[var(--color-text)]">
      <Sidebar
        workflows={workflows}
        services={services}
        selectedId={selectedId}
        onSelect={setSelectedId}
        status={socket.status}
        onClear={clearResolved}
      />
      <main className="flex flex-1 flex-col min-w-0">
        {selected ? (
          <WorkflowView
            key={selected.id}
            workflow={selected}
            socket={socket}
            onMutate={pollOnce}
          />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}

// ─────────────────────────── Sidebar ───────────────────────────

function Sidebar({ workflows, services, selectedId, onSelect, status, onClear }: {
  workflows: Workflow[]; services: Service[]; selectedId: string | null;
  onSelect: (id: string) => void; status: string; onClear: () => void;
}) {
  const failing = services.filter(s => s.status === "failing").length;
  const hasResolved = workflows.some(w => w.step === "resolved");

  return (
    <aside className="hidden lg:flex w-[300px] flex-shrink-0 flex-col hairline-r glass">
      {/* Brand */}
      <div className="px-5 pt-5 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}>
            <IconShield size={18} strokeWidth={1.8} />
          </div>
          <div>
            <div className="text-[15px] font-semibold tracking-tight">Argus</div>
            <div className="text-[11px]" style={{ color: "var(--color-text-3)" }}>Incident triage</div>
          </div>
        </div>
      </div>

      {/* Services snapshot */}
      <div className="px-5 pb-4">
        <SectionHeader>System</SectionHeader>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {services.map(s => (
            <ServiceChip key={s.name} svc={s} />
          ))}
        </div>
      </div>

      {/* Workflows */}
      <div className="px-5 pb-1.5 flex items-center justify-between gap-2">
        <SectionHeader>Workflows</SectionHeader>
        {hasResolved && (
          <button
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium hover:bg-[var(--color-bg-hover)]"
            style={{ color: "var(--color-text-3)" }}
            onClick={onClear}
            title="Clear resolved workflows"
          >
            <IconTrash size={10} /> Clear history
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {workflows.length === 0 ? (
          <div className="text-center text-xs mt-8" style={{ color: "var(--color-text-3)" }}>
            <IconCheck size={28} className="mx-auto mb-2 opacity-40" />
            All services healthy
          </div>
        ) : (
          <WorkflowList workflows={workflows} selectedId={selectedId} onSelect={onSelect} />
        )}
      </div>

      {/* Connection status */}
      <div className="px-5 py-3 hairline-t flex items-center gap-2 text-[11px]" style={{ color: "var(--color-text-3)" }}>
        <span
          className={`h-1.5 w-1.5 rounded-full ${status === "ready" || status === "connected" ? "" : "pulse-soft"}`}
          style={{ background: status === "ready" || status === "connected" ? "var(--color-success)" : status === "error" ? "var(--color-danger)" : "var(--color-warning)" }}
        />
        {status === "ready" || status === "connected" ? "Connected" : status}
      </div>
    </aside>
  );
}

function SectionHeader({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${className}`} style={{ color: "var(--color-text-3)" }}>
      {children}
    </div>
  );
}

function ServiceChip({ svc }: { svc: Service }) {
  const cfg = svc.status === "failing"
    ? { fg: "var(--color-danger)", bg: "var(--color-danger-soft)", pulse: true }
    : svc.status === "unknown"
    ? { fg: "var(--color-text-3)", bg: "var(--color-bg-elev-2)", pulse: false }
    : { fg: "var(--color-success)", bg: "var(--color-success-soft)", pulse: false };
  return (
    <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px]" style={{ background: cfg.bg, color: cfg.fg }}>
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.pulse ? "pulse-soft" : ""}`} style={{ background: cfg.fg }} />
      <span className="truncate">{svc.name}</span>
    </div>
  );
}

function WorkflowList({ workflows, selectedId, onSelect }: {
  workflows: Workflow[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const active = workflows.filter(w => w.step !== "resolved");
  const history = workflows.filter(w => w.step === "resolved");

  return (
    <>
      {active.map(w => (
        <WorkflowCard key={w.id} workflow={w} selected={selectedId === w.id} onClick={() => onSelect(w.id)} />
      ))}
      {history.length > 0 && (
        <>
          {active.length > 0 && (
            <div className="mt-3 mb-1 pl-2 text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--color-text-4)" }}>
              History
            </div>
          )}
          {history.map(w => (
            <WorkflowCard key={w.id} workflow={w} selected={selectedId === w.id} onClick={() => onSelect(w.id)} historical />
          ))}
        </>
      )}
    </>
  );
}

function WorkflowCard({ workflow, selected, onClick, historical = false }: {
  workflow: Workflow; selected: boolean; onClick: () => void; historical?: boolean;
}) {
  const step = WORKFLOW_STEPS.find(s => s.id === workflow.step) || WORKFLOW_STEPS[0];
  const idx = stepIndex(workflow.step);
  const hasCritical = workflow.firing_alerts.some(a => a.severity === "critical");
  const isResolved = workflow.step === "resolved";

  const accentColor = isResolved ? "var(--color-success)" : hasCritical ? "var(--color-danger)" : "var(--color-warning)";

  const progress = isResolved ? 1 : WORKFLOW_STEPS.length > 1 ? (idx + 1) / WORKFLOW_STEPS.length : 0;

  const dim = historical;
  let subtitle = "";
  if (isResolved) {
    const rel = relativeTime(workflow.ended_at);
    const dur = formatDuration(workflow.started_at, workflow.ended_at);
    subtitle = [rel, dur].filter(Boolean).join(" • ");
  } else {
    const rel = relativeTime(workflow.started_at);
    subtitle = rel ? `Started ${rel}` : "";
  }

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg px-2 py-1.5 mb-0.5 transition-colors ${selected ? "" : "hover:bg-[var(--color-bg-elev-2)]"}`}
      style={{
        background: selected ? "var(--color-bg-elev-2)" : "transparent",
        border: `1px solid ${selected ? "var(--color-line-strong)" : "transparent"}`,
        opacity: dim && !selected ? 0.7 : 1,
      }}
    >
      <div className="flex items-center gap-2">
        <div className="flex h-4 w-4 items-center justify-center rounded" style={{ background: `${accentColor}22`, color: accentColor }}>
          {stepIcon(workflow.step, { size: 10, strokeWidth: 2 })}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[12px] font-medium truncate">{workflow.service_name}</span>
            {workflow.incident && (
              <span className="text-[10px] font-mono" style={{ color: "var(--color-text-4)" }}>#{workflow.incident.id}</span>
            )}
            <span className="text-[10px] truncate ml-auto" style={{ color: "var(--color-text-3)" }}>{step.label}</span>
          </div>
          <div className="text-[10px] truncate" style={{ color: "var(--color-text-4)" }}>{subtitle}</div>
        </div>
        {workflow.firing_alerts.length > 0 && (
          <span className="text-[10px] font-semibold" style={{ color: accentColor }}>
            {workflow.firing_alerts.length}
          </span>
        )}
      </div>
      {/* Mini progress bar */}
      <div className="mt-1.5 h-[2px] rounded-full overflow-hidden" style={{ background: "var(--color-line)" }}>
        <div className="h-full transition-all"
             style={{
               width: `${progress * 100}%`,
               background: isResolved ? "var(--color-success)" : accentColor,
             }} />
      </div>
    </button>
  );
}

// ─────────────────────────── Empty state ───────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center max-w-sm fade-in">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
             style={{ background: "var(--color-success-soft)", color: "var(--color-success)" }}>
          <IconCheck size={28} strokeWidth={2} />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">All clear</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--color-text-2)" }}>
          No active incidents. Trigger a demo scenario to watch Argus triage in real time.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────── Workflow view (detail + chat) ───────────────────────────

function WorkflowView({ workflow, socket, onMutate }: { workflow: Workflow; socket: SocketApi; onMutate: () => void }) {
  const [chatOpen, setChatOpen] = useState(false);
  const [input, setInput] = useState("");
  const [chatWidth, setChatWidth] = useState(() => {
    const stored = Number(localStorage.getItem("argus.chatWidth"));
    return Number.isFinite(stored) && stored >= 320 ? stored : 420;
  });
  const chatRef = useRef<HTMLDivElement>(null);

  const messages = socket.chats[workflow.id] || [];
  const isStreaming = messages.some(m => m.streaming);

  // Auto-open chat when there are messages
  useEffect(() => {
    if (messages.length > 0) setChatOpen(true);
  }, [messages.length]);

  const toolLabelForWid = socket.toolByWid[workflow.id] || "";

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, toolLabelForWid]);

  const send = () => {
    const msg = input.trim();
    if (!msg) return;
    if (socket.send(workflow.id, msg, workflow.service_name)) setInput("");
  };

  const pendingConfirmation = (workflow.confirmations || []).find(c => (c.status || "pending") === "pending");

  const ask = (q: string) => {
    socket.send(workflow.id, q, workflow.service_name);
    setChatOpen(true);
  };

  const decide = async (id: number, choice: string) => {
    await fetch(`/api/confirmations/${id}/${choice}`, { method: "POST" });
    onMutate();
  };

  // The server only advances the workflow past "detected" once the agent calls
  // create_incident. But Argus often investigates for a while first — and we already
  // have that signal locally (an active chat thread for this workflow). Reflect it so
  // the pipeline, badge and header show "Investigating" the moment the agent starts,
  // instead of sitting on "Detected" with a stale CTA.
  const investigating = !workflow.incident && messages.length > 0 && workflow.step === "detected";
  const view: Workflow = investigating ? { ...workflow, step: "investigating" } : workflow;

  const currentStep = WORKFLOW_STEPS.find(s => s.id === view.step) || WORKFLOW_STEPS[0];
  const hasCritical = workflow.firing_alerts.some(a => a.severity === "critical");
  const accent = view.step === "resolved" ? "var(--color-success)" : hasCritical ? "var(--color-danger)" : "var(--color-warning)";

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Header */}
      <header className="glass-header hairline-b sticky top-0 z-20">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3.5">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl"
                 style={{ background: `${accent}22`, color: accent }}>
              {stepIcon(view.step, { size: 17, strokeWidth: 1.8 })}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-[15px] font-semibold tracking-tight truncate">{workflow.service_name}</h1>
                <span className="text-[10px] uppercase tracking-[0.08em] font-medium" style={{ color: "var(--color-text-3)" }}>{workflow.service_tier}</span>
                {workflow.incident && (
                  <span className="text-[11px] font-mono" style={{ color: "var(--color-text-3)" }}>· #{workflow.incident.id}</span>
                )}
              </div>
              <p className="text-[12px] truncate" style={{ color: "var(--color-text-2)" }}>{currentStep.desc}</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <HeaderTimings workflow={workflow} />
            <StatusBadge step={view.step} hasCritical={hasCritical} />
            <button onClick={() => setChatOpen(o => !o)} className={`btn ${chatOpen ? "btn-primary" : "btn-ghost"}`}>
              <IconChat size={14} /> Chat
            </button>
          </div>
        </div>
      </header>

      {/* Pipeline */}
      <Pipeline workflow={view} accent={accent} />

      {/* Body */}
      <div className={`flex flex-1 min-h-0 ${chatOpen ? "flex-row" : "flex-col"}`}>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto max-w-3xl space-y-4 fade-in">
            {workflow.step === "resolved" && <ResolvedBanner workflow={workflow} />}

            {pendingConfirmation && workflow.step !== "resolved" && workflow.step !== "verifying" && (
              <ApprovalCard
                confirmation={pendingConfirmation}
                onApprove={() => decide(pendingConfirmation.id, "approve")}
                onDecline={() => decide(pendingConfirmation.id, "decline")}
              />
            )}

            {workflow.incident && <IncidentCard incident={workflow.incident} />}

            {workflow.firing_alerts.length > 0 && (
              <Section title="Active Alerts" count={workflow.firing_alerts.length}>
                <div className="space-y-1.5">
                  {workflow.firing_alerts.map(a => <AlertRow key={a.id} alert={a} />)}
                </div>
              </Section>
            )}

            {!workflow.incident && workflow.firing_alerts.length > 0 && (
              investigating
                ? <InvestigatingPrompt service={workflow.service_name} onOpen={() => setChatOpen(true)} />
                : <InvestigatePrompt
                    service={workflow.service_name}
                    onAsk={() => ask(`Investigate ${workflow.service_name}. What's the root cause and what should we do?`)}
                  />
            )}

            <Timeline workflow={workflow} />

            {workflow.resolved_alerts.length > 0 && workflow.step !== "resolved" && (
              <Section title="Recently Resolved" count={workflow.resolved_alerts.length} muted>
                <div className="space-y-1.5">
                  {workflow.resolved_alerts.slice(0, 5).map(a => (
                    <div key={a.id} className="rounded-lg px-3 py-2 text-[12px] flex items-center justify-between"
                         style={{ background: "var(--color-bg-elev)", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-card)" }}>
                      <span style={{ color: "var(--color-text-2)" }}>{a.metric_name}</span>
                      <span style={{ color: "var(--color-text-3)" }}>{relativeTime(a.resolved_at)}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>

        {chatOpen && (
          <ChatPanel
            workflow={workflow}
            messages={messages}
            toolLabel={toolLabelForWid}
            input={input}
            setInput={setInput}
            onSend={send}
            onClose={() => setChatOpen(false)}
            isStreaming={isStreaming}
            chatRef={chatRef}
            width={chatWidth}
            onResize={(w) => { setChatWidth(w); localStorage.setItem("argus.chatWidth", String(w)); }}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────── Pipeline ───────────────────────────

function Pipeline({ workflow, accent }: { workflow: Workflow; accent: string }) {
  const idx = stepIndex(workflow.step);
  const isResolved = workflow.step === "resolved";
  const active = WORKFLOW_STEPS[idx] || WORKFLOW_STEPS[0];
  const fillColor = isResolved ? "var(--color-success)" : accent;
  const fillPct = WORKFLOW_STEPS.length > 1 ? idx / (WORKFLOW_STEPS.length - 1) : 0;

  return (
    <div className="hairline-b px-6 py-5" style={{ background: "color-mix(in oklab, var(--color-bg-sidebar) 60%, transparent)" }}>
      <div className="mx-auto max-w-6xl">
        {/* Stage header */}
        <div className="mb-4 flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-semibold tracking-tight" style={{ color: fillColor }}>
              {active.label}
            </span>
            <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>{active.desc}</span>
          </div>
          <span className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: "var(--color-text-3)" }}>
            Stage {Math.min(idx + 1, WORKFLOW_STEPS.length)} / {WORKFLOW_STEPS.length}
          </span>
        </div>

        <div className="relative flex items-start justify-between">
          {/* Connector track */}
          <div className="absolute top-[16px] left-[16px] right-[16px] h-[3px] rounded-full" style={{ background: "var(--color-line)" }} />
          {/* Progress fill — flowing shimmer while in-flight, solid when resolved */}
          <div
            className={`absolute top-[16px] left-[16px] h-[3px] rounded-full transition-all duration-700 ${isResolved ? "" : "connector-flow"}`}
            style={{
              width: `calc((100% - 32px) * ${fillPct})`,
              background: isResolved ? fillColor : undefined,
              "--flow-accent": accent,
            } as React.CSSProperties}
          />

          {WORKFLOW_STEPS.map((step, i) => {
            const isActive = i === idx && !isResolved;
            const done = isResolved || i < idx;
            const colorFg = done ? "var(--color-success)" : isActive ? "#fff" : "var(--color-text-3)";
            const colorBg = done ? "var(--color-success)" : isActive ? accent : "var(--color-bg-elev-2)";

            return (
              <div key={step.id} className="relative z-10 flex flex-col items-center" style={{ minWidth: 56 }}>
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-all ${isActive ? "node-active" : ""}`}
                  style={{
                    background: colorBg,
                    color: colorFg,
                    border: !done && !isActive ? "1.5px solid var(--color-line-strong)" : "none",
                    "--node-ring": `color-mix(in oklab, ${accent} 45%, transparent)`,
                  } as React.CSSProperties}
                >
                  {done
                    ? <IconCheck size={15} strokeWidth={2.5} />
                    : stepIcon(step.id, { size: 14, strokeWidth: isActive ? 2.2 : 1.8 })}
                </div>
                <div
                  className="mt-2 text-[10px] leading-tight text-center transition-colors"
                  style={{ color: done ? "var(--color-success)" : isActive ? "var(--color-text-1)" : "var(--color-text-3)", fontWeight: isActive ? 600 : 500 }}
                >
                  {step.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── Cards ───────────────────────────

function Section({ title, count, children, muted = false }: {
  title: string; count?: number; children: React.ReactNode; muted?: boolean;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: muted ? "var(--color-text-3)" : "var(--color-text-2)" }}>
          {title}
        </h3>
        {typeof count === "number" && (
          <span className="chip" style={{ background: "var(--color-bg-elev-2)", color: "var(--color-text-2)" }}>{count}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function StatusBadge({ step, hasCritical }: { step: string; hasCritical: boolean }) {
  const isResolved = step === "resolved";
  const fg = isResolved ? "var(--color-success)" : hasCritical ? "var(--color-danger)" : "var(--color-warning)";
  const bg = isResolved ? "var(--color-success-soft)" : hasCritical ? "var(--color-danger-soft)" : "var(--color-warning-soft)";
  return (
    <div className="chip" style={{ background: bg, color: fg }}>
      <span className="chip-dot" />
      {step.replace(/_/g, " ")}
    </div>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  const critical = alert.severity === "critical";
  const fg = critical ? "var(--color-danger)" : "var(--color-warning)";
  return (
    <div className="rounded-lg px-2.5 py-1.5 flex items-center gap-2" style={{ background: "var(--color-bg-elev)", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-card)" }}>
      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full pulse-soft" style={{ background: fg }} />
      <span className="text-[11.5px] font-medium flex-shrink-0" style={{ color: fg }}>{alert.metric_name}</span>
      <span className="text-[10.5px] flex-shrink-0" style={{ color: "var(--color-text-3)" }}>
        {alert.metric_value}/{alert.threshold}
      </span>
      <span className="text-[11px] truncate" style={{ color: "var(--color-text-2)" }} title={alert.message}>
        — {alert.message}
      </span>
    </div>
  );
}

function IncidentCard({ incident }: { incident: Incident }) {
  const statusColor =
    incident.status === "resolved" || incident.status === "mitigated"
      ? { fg: "var(--color-success)", bg: "var(--color-success-soft)" }
      : incident.status === "investigating"
      ? { fg: "var(--color-warning)", bg: "var(--color-warning-soft)" }
      : { fg: "var(--color-danger)", bg: "var(--color-danger-soft)" };
  return (
    <Section title={`Incident #${incident.id}`}>
      <div className="rounded-xl px-4 py-3.5" style={{ background: "var(--color-bg-elev)", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-card)" }}>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[14px] font-semibold tracking-tight">{incident.title}</span>
              <span className="chip" style={{ background: statusColor.bg, color: statusColor.fg }}>
                <span className="chip-dot" />
                {incident.status}
              </span>
            </div>
            {incident.description && (
              <div className="markdown mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--color-text-2)" }}
                   dangerouslySetInnerHTML={{ __html: renderMarkdown(incident.description) }} />
            )}
            {incident.likely_cause && (
              <div className="mt-2.5 rounded-lg px-3 py-2 text-[12px]"
                   style={{ background: "var(--color-violet-soft)", color: "var(--color-text)", border: "1px solid color-mix(in oklab, var(--color-violet) 25%, transparent)" }}>
                <div className="flex items-start gap-2">
                  <IconSparkle size={13} className="mt-0.5" style={{ color: "var(--color-violet)" }} />
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--color-violet)" }}>Root cause hypothesis</div>
                    <div className="markdown mt-0.5" style={{ color: "var(--color-text)" }}
                         dangerouslySetInnerHTML={{ __html: renderMarkdown(incident.likely_cause) }} />
                  </div>
                </div>
              </div>
            )}
            {incident.rca && (
              <div className="mt-2.5 rounded-lg px-3 py-2.5"
                   style={{ background: "var(--color-success-soft)", border: "1px solid color-mix(in oklab, var(--color-success) 28%, transparent)" }}>
                <div className="flex items-center gap-1.5">
                  <IconCheck size={12} strokeWidth={2.5} style={{ color: "var(--color-success)" }} />
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--color-success)" }}>Root cause analysis</div>
                </div>
                <div className="markdown mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--color-text)" }}
                     dangerouslySetInnerHTML={{ __html: renderMarkdown(incident.rca) }} />
              </div>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

function ApprovalCard({ confirmation, onApprove, onDecline }: {
  confirmation: Confirmation; onApprove: () => void; onDecline: () => void;
}) {
  return (
    <div className="rounded-xl px-4 py-4 fade-in"
         style={{ background: "var(--color-warning-soft)", border: "1px solid color-mix(in oklab, var(--color-warning) 35%, transparent)" }}>
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "var(--color-warning)", color: "black" }}>
          <IconClock size={16} strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--color-warning)" }}>
            Awaiting your approval
          </div>
          <div className="mt-1 text-[14px] font-medium" style={{ color: "var(--color-text)" }}>
            {confirmation.action}
          </div>
          <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-2)" }}>
            Requested by {confirmation.requested_by || "argus"}
          </div>
          <div className="mt-3 flex gap-2">
            <button className="btn btn-success" onClick={onApprove}>
              <IconCheck size={14} strokeWidth={2.2} /> Approve & Execute
            </button>
            <button className="btn btn-danger" onClick={onDecline}>
              <IconX size={14} strokeWidth={2} /> Decline
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InvestigatePrompt({ service, onAsk }: { service: string; onAsk: () => void }) {
  return (
    <div className="rounded-xl px-5 py-5 text-center"
         style={{ background: "var(--color-bg-elev)", border: "1px dashed var(--color-line-strong)" }}>
      <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-xl"
           style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}>
        <IconSparkle size={17} />
      </div>
      <div className="text-[14px] font-medium">No incident yet</div>
      <div className="mt-1 text-[12.5px]" style={{ color: "var(--color-text-2)" }}>
        Let Argus investigate {service} and propose remediation.
      </div>
      <button className="btn btn-primary mt-3" onClick={onAsk}>
        <IconSparkle size={13} /> Investigate with Argus
      </button>
    </div>
  );
}

function InvestigatingPrompt({ service, onOpen }: { service: string; onOpen: () => void }) {
  return (
    <div className="rounded-xl px-5 py-5 text-center"
         style={{ background: "var(--color-bg-elev)", border: "1px dashed var(--color-line-strong)" }}>
      <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-xl pulse-soft"
           style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}>
        <IconSparkle size={17} />
      </div>
      <div className="text-[14px] font-medium">Argus is investigating {service}…</div>
      <div className="mt-1 text-[12.5px]" style={{ color: "var(--color-text-2)" }}>
        Gathering signals and correlating alerts. An incident will appear once the root cause is identified.
      </div>
      <button className="btn btn-ghost mt-3" onClick={onOpen}>
        <IconChat size={13} /> View investigation
      </button>
    </div>
  );
}

function ResolvedBanner({ workflow }: { workflow: Workflow }) {
  const dur = formatDuration(workflow.started_at, workflow.ended_at);
  const count = workflow.resolved_alerts.length || workflow.firing_alerts.length;
  const parts = [
    `${workflow.service_name} recovered`,
    dur && `after ${dur}`,
    count > 0 && `${count} alert${count === 1 ? "" : "s"} cleared`,
  ].filter(Boolean);
  return (
    <div className="rounded-xl px-4 py-2.5 flex items-center gap-3 fade-in"
         style={{
           background: "var(--color-success-soft)",
           border: "1px solid color-mix(in oklab, var(--color-success) 30%, transparent)",
         }}>
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
           style={{ background: "var(--color-success)", color: "black" }}>
        <IconCheck size={14} strokeWidth={2.5} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold tracking-tight">Resolved</div>
        <div className="text-[11.5px]" style={{ color: "var(--color-text-2)" }}>{parts.join(" · ")}</div>
      </div>
      {workflow.ended_at && (
        <div className="text-right text-[10.5px] hidden sm:block" style={{ color: "var(--color-text-3)" }}>
          <div>{formatTime(workflow.ended_at)}</div>
          <div style={{ color: "var(--color-text-4)" }}>{relativeTime(workflow.ended_at)}</div>
        </div>
      )}
    </div>
  );
}

function HeaderTimings({ workflow }: { workflow: Workflow }) {
  const started = workflow.started_at;
  const ended = workflow.ended_at;
  if (!started) return null;
  return (
    <div className="hidden md:flex items-center gap-4 px-2 text-[11px]" style={{ color: "var(--color-text-2)" }}>
      <Stat label="Started" value={formatTime(started)} hint={relativeTime(started)} />
      {ended ? (
        <>
          <Divider />
          <Stat label="Resolved" value={formatTime(ended)} hint={relativeTime(ended)} />
          <Divider />
          <Stat label="Duration" value={formatDuration(started, ended)} mono />
        </>
      ) : (
        <>
          <Divider />
          <Stat label="Elapsed" value={formatDuration(started, null)} mono live />
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint, mono = false, live = false }: {
  label: string; value: React.ReactNode; hint?: string; mono?: boolean; live?: boolean;
}) {
  return (
    <div className="leading-tight">
      <div className="text-[9px] uppercase tracking-[0.08em] font-semibold" style={{ color: "var(--color-text-3)" }}>{label}</div>
      <div className={`text-[12px] font-medium ${mono ? "font-mono" : ""}`} style={{ color: "var(--color-text)" }}>
        {value}{live && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full pulse-soft align-middle" style={{ background: "var(--color-warning)" }} />}
      </div>
      {hint && <div className="text-[10px]" style={{ color: "var(--color-text-4)" }}>{hint}</div>}
    </div>
  );
}

function Divider() {
  return <div className="h-7 w-px" style={{ background: "var(--color-line)" }} />;
}

function Timeline({ workflow }: { workflow: Workflow }) {
  const events = [];
  if (workflow.started_at) events.push({ at: workflow.started_at, label: "Alert fired", kind: "danger" });
  if (workflow.incident) {
    events.push({ at: workflow.incident.created_at, label: `Incident #${workflow.incident.id} opened`, kind: "warning" });
    if (workflow.incident.status === "investigating") {
      events.push({ at: workflow.incident.updated_at, label: "Investigating", kind: "info" });
    }
    if (workflow.incident.likely_cause) {
      events.push({ at: workflow.incident.updated_at, label: "Root cause identified", kind: "violet" });
    }
  }
  for (const c of workflow.confirmations || []) {
    events.push({ at: c.created_at, label: `Approval requested: ${c.action}`, kind: "warning" });
    if (c.status === "approved") events.push({ at: c.resolved_at || c.created_at, label: "Approved · executing remediation", kind: "info" });
    if (c.status === "declined") events.push({ at: c.resolved_at || c.created_at, label: "Approval declined", kind: "danger" });
  }
  if (workflow.ended_at) events.push({ at: workflow.ended_at, label: "Resolved", kind: "success" });

  // De-dupe identical adjacent events and sort
  const seen = new Set();
  const sorted = events
    .filter(e => e.at)
    .sort((a, b) => (a.at || "").localeCompare(b.at || ""))
    .filter(e => { const k = `${e.at}|${e.label}`; if (seen.has(k)) return false; seen.add(k); return true; });

  if (sorted.length === 0) return null;

  const color = (k: string): string => (({
    danger: "var(--color-danger)",
    warning: "var(--color-warning)",
    success: "var(--color-success)",
    violet: "var(--color-violet)",
    info: "var(--color-accent)",
  }) as Record<string, string>)[k] || "var(--color-text-3)";

  return (
    <Section title="Timeline">
      <ol className="relative pl-4">
        <div className="absolute left-[5px] top-1 bottom-1 w-px" style={{ background: "var(--color-line)" }} />
        {sorted.map((e, i) => (
          <li key={i} className="relative pb-2 last:pb-0">
            <span className="absolute -left-[12px] top-[5px] block h-2 w-2 rounded-full ring-2"
                  style={{ background: color(e.kind), boxShadow: `0 0 0 2px var(--color-bg)` }} />
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px]" style={{ color: "var(--color-text)" }}>{e.label}</span>
              <span className="text-[10.5px] font-mono whitespace-nowrap" style={{ color: "var(--color-text-3)" }} title={e.at}>
                {formatTime(e.at)} · {relativeTime(e.at)}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ─────────────────────────── Chat ───────────────────────────

function ChatPanel({ workflow, messages, toolLabel: activeToolLabel, input, setInput, onSend, onClose, isStreaming, chatRef, width, onResize }: {
  workflow: Workflow; messages: ChatMsg[]; toolLabel: string; input: string;
  setInput: (v: string) => void; onSend: () => void; onClose: () => void; isStreaming: boolean;
  chatRef: React.RefObject<HTMLDivElement | null>; width: number; onResize: (w: number) => void;
}) {
  const draggingRef = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const next = Math.min(Math.max(window.innerWidth - e.clientX, 320), Math.min(900, window.innerWidth - 360));
      onResize(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onResize]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div className="relative flex-shrink-0 hairline-l flex flex-col" style={{ width, background: "var(--color-bg-sidebar)" }}>
      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        title="Drag to resize"
        className="absolute top-0 left-0 h-full z-30 group"
        style={{ width: 6, marginLeft: -3, cursor: "col-resize" }}
      >
        <div className="h-full w-[2px] mx-auto opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: "var(--color-accent)" }} />
      </div>

      <div className="px-4 py-2.5 hairline-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md" style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}>
            <IconChat size={12} />
          </div>
          <div>
            <div className="text-[12px] font-semibold tracking-tight">Argus</div>
            <div className="text-[10px]" style={{ color: "var(--color-text-3)" }}>Triage assistant</div>
          </div>
        </div>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-[var(--color-bg-elev-2)]" style={{ color: "var(--color-text-2)" }}>
          <IconClose size={13} />
        </button>
      </div>

      <div ref={chatRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {messages.length === 0 && (
          <div className="text-center mt-8 fade-in">
            <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-2xl" style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}>
              <IconSparkle size={17} />
            </div>
            <div className="text-[12px] font-medium">Ask about {workflow.service_name}</div>
            <div className="mt-1 text-[10.5px]" style={{ color: "var(--color-text-3)" }}>
              "What's wrong with {workflow.service_name}?"
            </div>
          </div>
        )}

        {messages.map(msg => (
          <ChatMessage
            key={msg.id}
            message={msg}
            toolLabel={msg.role === "agent" && msg.streaming ? activeToolLabel : ""}
          />
        ))}
      </div>

      <div className="hairline-t px-3 py-2.5">
        <div className="flex items-end gap-1.5 rounded-lg px-2.5 py-1.5"
             style={{ background: "var(--color-bg-elev)", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-card)" }}>
          <textarea
            className="flex-1 resize-none bg-transparent outline-none text-[12px] leading-snug placeholder:text-[var(--color-text-3)]"
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
            placeholder={`Ask about ${workflow.service_name}…`}
            style={{ minHeight: 20, maxHeight: 120 }}
          />
          <button
            className="btn btn-primary"
            style={{ padding: "5px 9px" }}
            disabled={!input.trim() || isStreaming}
            onClick={onSend}
          >
            <IconSend size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

const THINK_WORDS = [
  "Thinking", "Investigating", "Correlating", "Sleuthing", "Triaging",
  "Pondering", "Untangling", "Cross-referencing", "Connecting the dots",
  "Sniffing around", "Digging in", "Reasoning", "Piecing it together",
];
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Claude-Code-style working indicator: a spinner + a shimmering, cycling status word.
// Replaces the raw chain-of-thought dump — we show that Argus is working, not what it thinks.
function ThinkingIndicator({ label }: { label?: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 110);
    return () => clearInterval(t);
  }, []);
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
  // Change the word roughly every ~2s; if a tool label is active, prefer showing that.
  const word = label || THINK_WORDS[Math.floor(tick / 18) % THINK_WORDS.length];
  return (
    <div className="flex items-center gap-2 px-1.5 py-1 text-[12px]">
      <span className="font-mono text-[13px]" style={{ color: "var(--color-violet)" }}>{frame}</span>
      <span className="shimmer-text font-medium">{word}…</span>
    </div>
  );
}

function ChatMessage({ message, toolLabel = "" }: { message: ChatMsg; toolLabel?: string }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isUser) {
    // Auto-triage directives render as a centered system-ish chip, not a user bubble.
    if (message.auto) {
      return (
        <div className="flex justify-center fade-in">
          <div className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[10.5px] font-medium uppercase tracking-[0.06em]"
               style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}>
            <IconSparkle size={11} /> {message.content}
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-end fade-in">
        <div className="max-w-[88%] rounded-xl px-2.5 py-1.5 text-[12px] leading-snug"
             style={{ background: "var(--color-accent)", color: "white" }}>
          {message.content}
        </div>
      </div>
    );
  }
  if (isSystem) {
    return (
      <div className="flex justify-start fade-in">
        <div className="max-w-[88%] rounded-xl px-2.5 py-1.5 text-[11.5px]"
             style={{ background: "var(--color-danger-soft)", color: "var(--color-danger)", border: "1px solid color-mix(in oklab, var(--color-danger) 30%, transparent)" }}>
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start fade-in">
      <div className="max-w-[95%] space-y-1.5 w-full">
        {message.content && (
          <div
            className="markdown rounded-xl px-3 py-2 text-[12px] leading-relaxed"
            style={{ background: "var(--color-bg-elev)", border: "1px solid var(--color-line)", color: "var(--color-text)", boxShadow: "var(--shadow-card)" }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
          />
        )}
        {message.streaming && <ThinkingIndicator label={toolLabel} />}
      </div>
    </div>
  );
}

// ─────────────────────────── Utils ───────────────────────────

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    get_alert: "Fetching alert details",
    list_active_alerts: "Checking correlated alerts",
    check_service_health: "Checking service health",
    check_logs: "Querying logs & metrics",
    create_incident: "Creating incident",
    update_incident: "Updating incident",
    list_incidents: "Listing incidents",
    search_runbooks: "Searching runbooks",
    get_recent_deployments: "Checking deployments",
    notify_channel: "Sending notification",
    request_confirmation: "Requesting approval",
    execute_runbook_step: "Executing remediation",
  };
  return labels[name] || `Using ${name}`;
}

function parseTs(ts: string | null | undefined): number {
  if (!ts) return NaN;
  const iso = ts.includes("T") ? (ts.endsWith("Z") ? ts : ts + "Z") : ts.replace(" ", "T") + "Z";
  return new Date(iso).getTime();
}

function relativeTime(ts: string | null | undefined): string {
  const t = parseTs(ts);
  if (isNaN(t)) return "";
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatTime(ts: string | null | undefined): string {
  const t = parseTs(ts);
  if (isNaN(t)) return "";
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatDuration(startTs: string | null | undefined, endTs: string | null | undefined): string {
  const start = parseTs(startTs);
  const end = endTs ? parseTs(endTs) : Date.now();
  if (isNaN(start) || isNaN(end)) return "";
  let s = Math.max(0, Math.floor((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); s -= m * 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

createRoot(document.getElementById("root")!).render(<App />);
