/**
 * Tests for the human-in-the-loop approval gate.
 *
 * Safety invariant: execute_runbook_step MUST refuse to run if the confirmation is not
 * "approved". The agent proposes via request_confirmation; a human approves in the UI;
 * only then does the reconciler dispatch execution. This test pins the DB-level enforcement
 * so the gate can never be silently removed.
 *
 * Separately, we verify that an approved confirmation moves the workflow step to "executing"
 * — tying the DB state change to the UI pipeline label the human sees.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../db/schema.ts";
import { seedIfEmpty } from "../db/seed.ts";
import { initArgusTools, argusTools } from "../tools/argus-tools.ts";
import { computeWorkflowStep } from "../db/workflow.ts";
import type { AlertWithService, IncidentRow, ConfirmationRow } from "../db/types.ts";

let db: Database;

beforeEach(() => {
  db = initDb(":memory:");
  seedIfEmpty(db);
  initArgusTools(db); // inject the test DB into the tools module
});

function setupIncidentAndConfirmation(confirmationStatus: "pending" | "approved" | "declined") {
  const svcId = (db.query("SELECT id FROM services WHERE name = 'pgsql'").get() as { id: number }).id;

  db.query("INSERT INTO incidents (title, severity, status) VALUES (?, ?, ?)").run(
    "pgsql pool exhausted", "critical", "investigating"
  );
  const incidentId = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  db.query("INSERT INTO confirmations (incident_id, action, status) VALUES (?, ?, ?)").run(
    incidentId, `Restart pgsql connection pool on service ${svcId}`, confirmationStatus
  );
  const confirmationId = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  return { incidentId, confirmationId, svcId };
}

const executeRunbookStep = argusTools.find(t => t.name === "execute_runbook_step")!;

function parseToolResult(result: { content: { type: string; text?: string }[] }) {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") throw new Error("unexpected tool result shape");
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe("approval gate — execute_runbook_step", () => {
  test("refuses execution when confirmation is pending", async () => {
    const { incidentId, confirmationId } = setupIncidentAndConfirmation("pending");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (executeRunbookStep.execute as any)("test", {
      incident_id: incidentId,
      step_id: 1,
      service: "pgsql",
      command: "restart connection pool",
      confirmation_id: confirmationId,
    }, undefined, undefined);

    const parsed = parseToolResult(result);
    expect(parsed).toHaveProperty("error");
    expect(String(parsed.error)).toContain("pending");
    expect(String(parsed.error)).toContain("not approved");
  });

  test("refuses execution when confirmation does not exist", async () => {
    const { incidentId } = setupIncidentAndConfirmation("pending");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (executeRunbookStep.execute as any)("test", {
      incident_id: incidentId,
      step_id: 1,
      service: "pgsql",
      command: "restart connection pool",
      confirmation_id: 9999,
    }, undefined, undefined);

    const parsed = parseToolResult(result);
    expect(parsed).toHaveProperty("error");
    expect(String(parsed.error)).toContain("not found");
  });

  test("refuses execution when confirmation is declined", async () => {
    const { incidentId, confirmationId } = setupIncidentAndConfirmation("declined");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (executeRunbookStep.execute as any)("test", {
      incident_id: incidentId,
      step_id: 1,
      service: "pgsql",
      command: "restart connection pool",
      confirmation_id: confirmationId,
    }, undefined, undefined);

    const parsed = parseToolResult(result);
    expect(parsed).toHaveProperty("error");
    expect(String(parsed.error)).toContain("declined");
  });
});

describe("approval gate — workflow step transitions", () => {
  const firing = { status: "firing" } as AlertWithService;

  function incident(status: IncidentRow["status"]): IncidentRow {
    return { id: 1, title: "t", severity: "critical", status, likely_cause: null, root_cause_service_id: null } as IncidentRow;
  }

  test("pending confirmation → workflow shows 'confirmation' (waiting for human)", () => {
    const conf = { status: "pending" } as ConfirmationRow;
    expect(computeWorkflowStep([firing], incident("investigating"), [conf])).toBe("confirmation");
  });

  test("approved confirmation → workflow shows 'executing' (gate cleared)", () => {
    const conf = { status: "approved" } as ConfirmationRow;
    expect(computeWorkflowStep([firing], incident("investigating"), [conf])).toBe("executing");
  });

  test("no confirmation → workflow never jumps to executing on its own", () => {
    // No human action → must stay at investigation/remediation, never skip to executing.
    const step = computeWorkflowStep([firing], incident("investigating"), []);
    expect(step).not.toBe("executing");
    expect(step).not.toBe("resolved");
  });
});
