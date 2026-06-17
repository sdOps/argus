// Client-side view models. Mirror the server's API payloads (argus-server/db/types.ts).

export interface Alert {
  id: number;
  service_id: number;
  severity: "warning" | "critical";
  metric_name: string;
  metric_value: number;
  threshold: number;
  message: string;
  status: "firing" | "resolved";
  fired_at: string;
  resolved_at: string | null;
  service_name?: string;
  service_tier?: string;
}

export interface Incident {
  id: number;
  title: string;
  description: string | null;
  severity: string;
  likely_cause: string | null;
  rca: string | null;
  root_cause_service_id: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Confirmation {
  id: number;
  incident_id: number;
  action: string;
  requested_by: string | null;
  status: string;
  resolved_at: string | null;
  created_at: string;
}

export interface Service {
  id: number;
  name: string;
  port: number;
  tier: string;
  status: string;
}

export type WorkflowStep =
  | "detected" | "investigating" | "root_cause" | "remediation"
  | "confirmation" | "executing" | "verifying" | "resolved";

export interface Workflow {
  id: string;
  kind: "incident" | "pending";
  service_name: string;
  service_tier: string;
  service_status: string;
  step: WorkflowStep;
  firing_alerts: Alert[];
  resolved_alerts: Alert[];
  incident: Incident | null;
  confirmations: Confirmation[];
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMsg {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  auto?: boolean;
  streaming?: boolean;
}

export interface Metadata {
  provider: string;
  model: string;
  thinkingLevel?: string;
  tools: string[];
  availableModels?: unknown[];
}

/** Return shape of the useArgusSocket hook. */
export interface SocketApi {
  status: string;
  chats: Record<string, ChatMsg[]>;
  toolByWid: Record<string, string>;
  metadata: Metadata | null;
  send: (wid: string, message: string, service?: string) => boolean;
  migrateChat: (fromId: string, toId: string) => void;
}

export interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}
