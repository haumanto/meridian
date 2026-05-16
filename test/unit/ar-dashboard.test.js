// AR dashboard aggregator + results reader. baseDir injected at a
// tmpdir so this never touches the real profiles/ or research/ trees.
// Pattern mirrors autoresearch-ledger.test.js.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { readArResults, appendArResult } from "../../autoresearch-ledger.js";
import { getArSnapshot } from "../../ar-dashboard.js";

describe("readArResults", () => {
  let baseDir;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-dash-")); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("missing ledger → zeroed summary", () => {
    expect(readArResults("run-001", baseDir)).toEqual({
      count: 0, total_pnl_usd: 0, total_pnl_sol: 0,
      avg_pnl_pct: 0, win_rate_pct: 0, recent: [],
    });
  });

  it("aggregates totals / win-rate / avg and returns newest-first recent", () => {
    appendArResult({ runId: "r", pool_name: "A", pnl_usd: 10, pnl_pct: 2, pnl_sol: 0.1 }, baseDir);
    appendArResult({ runId: "r", pool_name: "B", pnl_usd: -4, pnl_pct: -1, pnl_sol: -0.04 }, baseDir);
    appendArResult({ runId: "r", pool_name: "C", pnl_usd: 6, pnl_pct: 1, pnl_sol: 0.06 }, baseDir);
    const s = readArResults("r", baseDir);
    expect(s.count).toBe(3);
    expect(s.total_pnl_usd).toBeCloseTo(12, 6);
    expect(s.total_pnl_sol).toBeCloseTo(0.12, 6);
    expect(s.avg_pnl_pct).toBeCloseTo(0.67, 2);
    expect(s.win_rate_pct).toBe(67); // 2 of 3 > 0
    expect(s.recent.map((x) => x.pool_name)).toEqual(["C", "B", "A"]); // newest-first
  });

  it("tolerates blank + malformed (partial trailing) lines", () => {
    const f = path.join(baseDir, "research", "runs", "r", "results.jsonl");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, [
      JSON.stringify({ pool_name: "ok", pnl_usd: 1, pnl_pct: 1, pnl_sol: 0.01 }),
      "",
      "{ truncated partial line",
    ].join("\n"));
    const s = readArResults("r", baseDir);
    expect(s.count).toBe(1);
    expect(s.total_pnl_usd).toBe(1);
  });
});

describe("getArSnapshot", () => {
  let baseDir;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-snap-")); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  function writeArProfile(state, uc) {
    const arDir = path.join(baseDir, "profiles", "autoresearch");
    fs.mkdirSync(arDir, { recursive: true });
    fs.writeFileSync(path.join(arDir, "state.json"), JSON.stringify(state));
    fs.writeFileSync(path.join(arDir, "user-config.json"), JSON.stringify(uc));
  }

  it("returns {configured:false} when the AR profile dir is absent", () => {
    expect(getArSnapshot(baseDir)).toEqual({ configured: false });
  });

  it("maps caps, filters open positions, derives headroom + liveness", () => {
    const nowIso = new Date().toISOString();
    writeArProfile(
      {
        positions: {
          OPEN1: { position: "OPEN1", pool: "P1", pool_name: "AAA-SOL", amount_sol: 0.3, closed: false, deployed_at: nowIso },
          DONE1: { position: "DONE1", pool: "P2", pool_name: "BBB-SOL", amount_sol: 0.3, closed: true },
        },
        recentEvents: [{ ts: nowIso, action: "deploy", pool_name: "AAA-SOL" }],
        lastUpdated: nowIso,
        deploy_rate: { timestamps: [Date.now()] },
      },
      {
        deployAmountSol: 0.3, maxPositions: 1,
        autoresearch: { enabled: true, runId: "run-001", capitalBudgetPct: 0.02, maxWalletSol: 0.6, dailyLossLimitSol: 0.15 },
      },
    );
    // a losing close TODAY → todayLoss 0.05 → headroom 0.10
    appendArResult({ runId: "run-001", pool_name: "BBB-SOL", pnl_usd: -8, pnl_pct: -3, pnl_sol: -0.05 }, baseDir);

    const s = getArSnapshot(baseDir);
    expect(s.configured).toBe(true);
    expect(s.alive).toBe(true);                       // lastUpdated just now
    expect(s.runId).toBe("run-001");
    expect(s.openCount).toBe(1);
    expect(s.positions.map((p) => p.position)).toEqual(["OPEN1"]); // closed excluded
    expect(s.caps).toMatchObject({ maxWalletSol: 0.6, dailyLossLimitSol: 0.15, maxPositions: 1, deployAmountSol: 0.3 });
    expect(s.deploysToday).toBe(1);
    expect(s.todayLossSol).toBeCloseTo(0.05, 6);
    expect(s.dailyLossHeadroomSol).toBeCloseTo(0.10, 6);
    expect(s.results.count).toBe(1);
    expect(s.recentEvents.length).toBe(1);
  });

  it("alive=false when both state + logs are stale (> 5 min)", () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeArProfile(
      { positions: {}, lastUpdated: old, deploy_rate: { timestamps: [] } },
      { autoresearch: { runId: "run-001", maxWalletSol: 0.6, dailyLossLimitSol: 0.15 } },
    );
    const s = getArSnapshot(baseDir);
    expect(s.configured).toBe(true);
    expect(s.alive).toBe(false);
    expect(s.openCount).toBe(0);
  });

  it("alive=true from a FRESH log file even when state.json is stale", () => {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    writeArProfile(
      { positions: {}, lastUpdated: old, deploy_rate: { timestamps: [] } },
      { autoresearch: { runId: "run-001", maxWalletSol: 0.6, dailyLossLimitSol: 0.15 } },
    );
    // poller appends to <arDir>/logs/agent-*.log every ~30s → fresh mtime
    const logsDir = path.join(baseDir, "profiles", "autoresearch", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "agent-2026-05-16.log"), "tick\n");
    const s = getArSnapshot(baseDir);
    expect(s.alive).toBe(true);                       // heartbeat from log mtime
    expect(s.lastHeartbeat).not.toBeNull();
    expect(Date.parse(s.lastHeartbeat)).toBeGreaterThan(Date.parse(old));
  });
});
