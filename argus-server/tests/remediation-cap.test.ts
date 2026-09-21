/**
 * Tests for the per-incident remediation attempt cap.
 *
 * An LLM in a restart loop against a service that will not come back is expensive and
 * noisy. execute_runbook_step must stop after a configured number of attempts and leave
 * the incident open for operator direction. The reconciler also skips execution once the
 * cap is reached.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../db/schema.ts";
import { seedIfEmpty } from "../db/seed.ts";
import { initArgusTools, argusTools } from "../tools/argus-tools.ts";

let db: Database;
const ORIGINAL_EXECUTOR_URL = process.env.EXECUTOR_URL;
const ORIGINAL_CAP = process.env.REMEDIATION_ATTEMPT_CAP;

beforeEach(() => {
  db = initDb(":memory:");
  seedIfEmpty(db);
  initArgusTools(db);
  // Point at a port that will refuse the connection so every call fails deterministically.
  process.env.EXECUTOR_URL = "http://127.0.0.1:1";
  process.env.REMEDIATION_ATTEMPT_CAP = "3";
});

afterEach(() => {
  process.env.EXECUTOR_URL = ORIGINAL_EXECUTOR_URL;
  process.env.REMEDIATION_ATTEMPT_CAP = ORIGINAL_CAP;
});

const executeRunbookStep = argusTools.find(t => t.name === "execute_runbook_step")!;

function parseToolResult(result: { content: { type: string; text?: string }[] }) {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") throw new Error("unexpected tool result shape");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function createApprovedIncident() {
  const svcId = (db.query("SELECT id FROM services WHERE name = 'pgsql'").get() as { id: number }).id;

  db.query("INSERT INTO incidents (title, severity, status) VALUES (?, ?, ?)").run(
    "pgsql pool exhausted", "critical", "investigating"
  );
  const incidentId = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  db.query("INSERT INTO confirmations (incident_id, action, status) VALUES (?, ?, ?)").run(
    incidentId, "Restart pgsql container", "approved"
  );
  const confirmationId = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  return { incidentId, confirmationId, svcId };
}

describe("remediation attempt cap", () => {
  test("allows attempts up to the cap and then refuses", async () => {
    const { incidentId, confirmationId } = createApprovedIncident();

    for (let i = 1; i <= 3; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (executeRunbookStep.execute as any)("test", {
        incident_id: incidentId,
        step_id: 2,
        service: "pgsql",
        confirmation_id: confirmationId,
      }, undefined, undefined);
      const parsed = parseToolResult(result);
      expect(parsed.error).toBeTruthy();
      expect(String(parsed.error)).toContain("executor");
      expect(parsed.attempts).toBe(i);
    }

    // Fourth call must be refused by the cap, not by the executor.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocked = await (executeRunbookStep.execute as any)("test", {
      incident_id: incidentId,
      step_id: 2,
      service: "pgsql",
      confirmation_id: confirmationId,
    }, undefined, undefined);
    const parsed = parseToolResult(blocked);
    expect(String(parsed.error)).toContain("cap");
    expect(String(parsed.error)).toContain("3");
  });

  test("refuses a non-executable runbook step", async () => {
    const { incidentId, confirmationId } = createApprovedIncident();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (executeRunbookStep.execute as any)("test", {
      incident_id: incidentId,
      step_id: 1,
      service: "pgsql",
      confirmation_id: confirmationId,
    }, undefined, undefined);
    const parsed = parseToolResult(result);
    expect(String(parsed.error)).toContain("manual");
    expect(String(parsed.error)).toContain("not \"executable\"");
  });
});
