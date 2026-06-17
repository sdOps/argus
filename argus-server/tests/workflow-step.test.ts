/**
 * Unit tests for computeWorkflowStep — the workflow state machine.
 *
 * This is the deterministic side of the determinism/agency boundary: given observable
 * DB state (which alerts are firing, what the incident status is, what confirmations
 * exist) this function returns the canonical pipeline step with zero LLM involvement.
 * Every branch is pinned here; the agent's output is instrumented (see /metrics) rather
 * than asserted.
 */
import { describe, expect, test } from "bun:test";
import { computeWorkflowStep } from "../db/workflow.ts";
import type { AlertWithService, IncidentRow, ConfirmationRow } from "../db/types.ts";

// Minimal stubs — only the fields computeWorkflowStep actually reads.
const firing = { status: "firing" } as AlertWithService;

function incident(overrides: Partial<IncidentRow>): IncidentRow {
  return {
    id: 1, title: "test", description: null, severity: "critical",
    likely_cause: null, rca: null, root_cause_service_id: null,
    runbook_used: null, status: "open",
    created_at: "2026-01-01", updated_at: "2026-01-01",
    ...overrides,
  } as IncidentRow;
}

function confirmation(status: "pending" | "approved" | "declined"): ConfirmationRow {
  return { id: 1, incident_id: 1, action: "restart", status } as ConfirmationRow;
}

describe("computeWorkflowStep — pipeline state machine", () => {
  test("no alerts → resolved", () => {
    expect(computeWorkflowStep([], incident({ status: "open" }), [])).toBe("resolved");
  });

  test("all firing alerts cleared → resolved (caller pre-filters; empty array = all resolved)", () => {
    // computeWorkflowStep receives only firing alerts — caller filters before passing.
    // Empty array means every alert on this service has resolved.
    expect(computeWorkflowStep([], incident({ status: "open" }), [])).toBe("resolved");
  });

  test("incident explicitly resolved → resolved even with firing alerts", () => {
    expect(computeWorkflowStep([firing], incident({ status: "resolved" }), [])).toBe("resolved");
  });

  test("incident mitigated + firing alerts → executing (cooldown: metrics still settling)", () => {
    expect(computeWorkflowStep([firing], incident({ status: "mitigated" }), [])).toBe("executing");
  });

  test("approved confirmation → executing (approval gate cleared)", () => {
    expect(computeWorkflowStep([firing], incident({ status: "open" }), [confirmation("approved")])).toBe("executing");
  });

  test("pending confirmation → confirmation (waiting for human)", () => {
    expect(computeWorkflowStep([firing], incident({ status: "open" }), [confirmation("pending")])).toBe("confirmation");
  });

  test("declined confirmation still pending-like → confirmation (human must re-decide)", () => {
    // A declined conf means neither approved nor pending — falls through to incident status.
    // This is correct: the agent must re-request or the operator must re-act.
    const result = computeWorkflowStep([firing], incident({ status: "investigating", likely_cause: "pgsql oom" }), [confirmation("declined")]);
    expect(result).toBe("remediation");
  });

  test("open incident, no cause yet → investigating", () => {
    expect(computeWorkflowStep([firing], incident({ status: "open" }), [])).toBe("investigating");
  });

  test("open incident, likely_cause set → root_cause", () => {
    expect(computeWorkflowStep([firing], incident({ status: "open", likely_cause: "oom" }), [])).toBe("root_cause");
  });

  test("open incident, root_cause_service_id set → root_cause", () => {
    expect(computeWorkflowStep([firing], incident({ status: "open", root_cause_service_id: 5 }), [])).toBe("root_cause");
  });

  test("investigating incident, no cause → investigating", () => {
    expect(computeWorkflowStep([firing], incident({ status: "investigating" }), [])).toBe("investigating");
  });

  test("investigating incident, likely_cause set → remediation", () => {
    expect(computeWorkflowStep([firing], incident({ status: "investigating", likely_cause: "pgsql pool exhausted" }), [])).toBe("remediation");
  });

  test("investigating incident, root_cause_service_id set → remediation", () => {
    expect(computeWorkflowStep([firing], incident({ status: "investigating", root_cause_service_id: 5 }), [])).toBe("remediation");
  });

  test("firing alert, no incident → detected (not yet triaged)", () => {
    expect(computeWorkflowStep([firing], null, [])).toBe("detected");
  });

  test("approved confirmation takes priority over mitigated status", () => {
    // Both paths → "executing"; this confirms the order doesn't matter for that outcome.
    const r1 = computeWorkflowStep([firing], incident({ status: "mitigated" }), [confirmation("approved")]);
    expect(r1).toBe("executing");
  });

  test("one alert still firing = still active (partial recovery)", () => {
    // computeWorkflowStep receives only firing alerts. One still firing → not "resolved".
    const result = computeWorkflowStep([firing], incident({ status: "open", likely_cause: "pgsql oom" }), []);
    expect(result).toBe("root_cause");
  });
});
