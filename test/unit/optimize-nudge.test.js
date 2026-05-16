// The "run /optimize" Telegram nudge must hold until the oldest closed
// position clears the /optimize-meridian recency gate (default 3 days) —
// otherwise it nags for a run that can only come back health-only.

import { describe, it, expect, beforeAll } from "vitest";

let evaluateOptimizeNudge;
beforeAll(async () => {
  ({ evaluateOptimizeNudge } = await import("../../lessons.js"));
});

const DAY = 86_400_000;
const now = Date.parse("2026-05-16T00:00:00Z");
const marker = { last_notify_close_count: 0, last_run_close_count: 0 };

describe("evaluateOptimizeNudge", () => {
  it("disabled when threshold is 0", () => {
    expect(evaluateOptimizeNudge({ total: 50, marker, threshold: 0 }).fire).toBe(false);
  });

  it("does not fire below the close threshold", () => {
    const v = evaluateOptimizeNudge({ total: 7, marker, threshold: 10, oldestPerfMs: now - 9 * DAY, nowMs: now });
    expect(v.fire).toBe(false);
    expect(v.reason).toBe("below-threshold");
  });

  it("HOLDS when threshold met but data younger than the recency gate", () => {
    const v = evaluateOptimizeNudge({
      total: 12, marker, threshold: 10,
      minDataAgeDays: 3, oldestPerfMs: now - 1.76 * DAY, nowMs: now,
    });
    expect(v.fire).toBe(false);
    expect(v.reason).toBe("recency-gate");
    expect(v.ageDays).toBeCloseTo(1.76, 2);
    expect(v.opensInDays).toBeCloseTo(1.24, 2);
  });

  it("FIRES when threshold met and data old enough", () => {
    const v = evaluateOptimizeNudge({
      total: 12, marker, threshold: 10,
      minDataAgeDays: 3, oldestPerfMs: now - 4 * DAY, nowMs: now,
    });
    expect(v.fire).toBe(true);
    expect(v.reason).toBe("ok");
    expect(v.sinceLastRun).toBe(12);
  });

  it("exactly at the gate boundary fires (>=, not >)", () => {
    const v = evaluateOptimizeNudge({
      total: 10, marker, threshold: 10,
      minDataAgeDays: 3, oldestPerfMs: now - 3 * DAY, nowMs: now,
    });
    expect(v.fire).toBe(true);
  });

  it("minDataAgeDays=0 disables the hold (legacy behaviour)", () => {
    const v = evaluateOptimizeNudge({
      total: 10, marker, threshold: 10,
      minDataAgeDays: 0, oldestPerfMs: now - 0.1 * DAY, nowMs: now,
    });
    expect(v.fire).toBe(true);
  });

  it("missing oldest timestamp skips the gate (can't compute age)", () => {
    const v = evaluateOptimizeNudge({
      total: 10, marker, threshold: 10, minDataAgeDays: 3, oldestPerfMs: null, nowMs: now,
    });
    expect(v.fire).toBe(true);
  });

  it("delta is measured since the last NOTIFY, not last run", () => {
    const m = { last_notify_close_count: 20, last_run_close_count: 5 };
    expect(evaluateOptimizeNudge({ total: 28, marker: m, threshold: 10, oldestPerfMs: now - 9 * DAY, nowMs: now }).fire).toBe(false);
    const v = evaluateOptimizeNudge({ total: 31, marker: m, threshold: 10, oldestPerfMs: now - 9 * DAY, nowMs: now });
    expect(v.fire).toBe(true);
    expect(v.sinceLastRun).toBe(26); // 31 - last_run_close_count(5)
  });
});
