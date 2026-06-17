/**
 * Tests for the post-recovery cooldown guard (isServiceInCooldown / markServiceRecovered).
 *
 * After execute_runbook_step recovers a service, the scraper suppresses NEW alert creation
 * for RECOVERY_COOLDOWN_SEC (30 s). This kills the phantom "detected" workflow that used to
 * flicker when a scrape reading taken on the recovery boundary landed just after the incident
 * closed. The guard is deterministic DB logic — testable in isolation with an in-memory DB.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../db/schema.ts";
import { seedIfEmpty } from "../db/seed.ts";
import { isServiceInCooldown, markServiceRecovered } from "../db/api.ts";

let db: Database;
let pgsqlId: number;

beforeEach(() => {
  db = initDb(":memory:");
  seedIfEmpty(db);
  pgsqlId = (db.query("SELECT id FROM services WHERE name = 'pgsql'").get() as { id: number }).id;
  // Clear any recovered_at left by a previous test in the same process.
  db.query("UPDATE services SET recovered_at = NULL WHERE id = ?").run(pgsqlId);
});

describe("isServiceInCooldown", () => {
  test("no recovered_at → not in cooldown", () => {
    expect(isServiceInCooldown(db, pgsqlId, 30)).toBe(false);
  });

  test("just recovered → in cooldown", () => {
    markServiceRecovered(db, pgsqlId);
    expect(isServiceInCooldown(db, pgsqlId, 30)).toBe(true);
  });

  test("recovered more than windowSec ago → not in cooldown", () => {
    // Backdate recovered_at to 60 seconds ago.
    db.query("UPDATE services SET recovered_at = datetime('now', '-60 seconds') WHERE id = ?").run(pgsqlId);
    expect(isServiceInCooldown(db, pgsqlId, 30)).toBe(false);
  });

  test("window=0 → never in cooldown (edge: zero-length window)", () => {
    markServiceRecovered(db, pgsqlId);
    expect(isServiceInCooldown(db, pgsqlId, 0)).toBe(false);
  });

  test("nonexistent service → not in cooldown", () => {
    expect(isServiceInCooldown(db, 9999, 30)).toBe(false);
  });

  test("cooldown is per-service — other services unaffected", () => {
    const redisId = (db.query("SELECT id FROM services WHERE name = 'redis'").get() as { id: number }).id;
    markServiceRecovered(db, pgsqlId);
    // redis is not in cooldown even though pgsql just recovered
    expect(isServiceInCooldown(db, redisId, 30)).toBe(false);
    expect(isServiceInCooldown(db, pgsqlId, 30)).toBe(true);
  });
});
