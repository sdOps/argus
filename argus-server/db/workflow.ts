import type { AlertWithService, IncidentRow, ConfirmationRow, WorkflowStep } from "./types.ts";

/**
 * Pure function — the workflow state machine.
 *
 * Maps observed DB state (firing alerts, incident status, confirmations) to a single
 * WorkflowStep label. All logic here is deterministic and testable without touching
 * the agent. This is the boundary: below this line is mechanism; above it is judgement.
 */
export function computeWorkflowStep(
  firingAlerts: AlertWithService[],
  incident: IncidentRow | null,
  confirmations: ConfirmationRow[],
): WorkflowStep {
  const pending = confirmations.filter(c => (c.status || "pending") === "pending");
  const approved = confirmations.filter(c => c.status === "approved");

  // No firing alerts or incident explicitly closed → done
  if (firingAlerts.length === 0) return "resolved";
  if (incident && incident.status === "resolved") return "resolved";

  // Fix applied and metrics confirmed healthy; agent is writing RCA before closing
  if (incident && incident.status === "mitigated") return "verifying";
  if (approved.length > 0) return "executing";
  if (pending.length > 0) return "confirmation";

  if (incident) {
    if (incident.status === "investigating") {
      if (incident.root_cause_service_id || incident.likely_cause) return "remediation";
      return "investigating";
    }
    if (incident.status === "open") {
      if (incident.likely_cause || incident.root_cause_service_id) return "root_cause";
      return "investigating";
    }
  }

  return "detected";
}
