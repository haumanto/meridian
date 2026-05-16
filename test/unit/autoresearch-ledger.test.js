// AR run ledger: append-one-line-per-close + the daily-loss
// circuit-breaker sum. baseDir is injected at a tmpdir so this never
// touches the real research/runs tree.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { appendArResult, computeTodayRunLossSol, arResultsPath } from "../../autoresearch-ledger.js";

describe("autoresearch ledger", () => {
  let baseDir;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-ledger-")); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  const today = new Date().toISOString().slice(0, 10);

  it("appendArResult creates research/runs/<id>/results.jsonl and stamps ts", () => {
    appendArResult({ runId: "run-001", pool: "P", pnl_sol: -0.01, reason: "stop loss" }, baseDir);
    const f = arResultsPath("run-001", baseDir);
    expect(f).toBe(path.join(baseDir, "research", "runs", "run-001", "results.jsonl"));
    const lines = fs.readFileSync(f, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ runId: "run-001", pool: "P", pnl_sol: -0.01, reason: "stop loss" });
    expect(typeof rec.ts).toBe("string");
  });

  it("computeTodayRunLossSol → 0 when ledger missing", () => {
    expect(computeTodayRunLossSol("nope", baseDir)).toBe(0);
  });

  it("sums only TODAY's negative pnl_sol as a positive magnitude", () => {
    appendArResult({ runId: "r", pnl_sol: -0.01 }, baseDir);
    appendArResult({ runId: "r", pnl_sol: -0.025 }, baseDir);
    appendArResult({ runId: "r", pnl_sol: 0.05 }, baseDir);   // win ignored
    appendArResult({ runId: "r", pnl_sol: null }, baseDir);   // no sol figure ignored
    const loss = computeTodayRunLossSol("r", baseDir);
    expect(loss).toBeCloseTo(0.035, 6);
  });

  it("ignores entries from other UTC days and malformed lines", () => {
    const f = arResultsPath("r", baseDir);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, [
      JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", pnl_sol: -9 }), // old day
      "{ not json",                                                    // malformed
      JSON.stringify({ ts: `${today}T12:00:00.000Z`, pnl_sol: -0.02 }), // counts
      "",                                                              // blank
    ].join("\n"));
    expect(computeTodayRunLossSol("r", baseDir)).toBeCloseTo(0.02, 6);
  });
});
