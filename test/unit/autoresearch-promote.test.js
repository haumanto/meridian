// evaluatePromotions is PURE (data in → findings out, no I/O). It is the
// gate that decides when AR pings the operator to promote a pattern, so
// the bar logic + dedupe must be exact. Isolated via MERIDIAN_DATA_DIR
// (module computes paths at import) per the proven suite pattern.

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

let evaluatePromotions, patternKey, sigOf;
beforeAll(async () => {
  process.env.MERIDIAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "arp-"));
  ({ evaluatePromotions, patternKey, sigOf } = await import("../../autoresearch-promote.js"));
});

// helper: a closed-trade record across N pools
const recs = (n, { strategy = "spot", bin = 80, vol = 2.5, pnl = 2, pools = n } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    strategy, bin_step: bin, volatility: vol,
    pnl_pct: pnl, pnl_usd: pnl, pnl_sol: pnl / 100,
    pool: `POOL_${i % pools}`,
  }));

const CFG = { minCloses: 4, minPools: 2, minWinRatePct: 60 };

describe("evaluatePromotions — the promotion bar", () => {
  it("below minCloses → no finding", () => {
    expect(evaluatePromotions({ perf: recs(3), cfg: CFG })).toEqual([]);
  });

  it("enough closes but single pool → rejected (not generalizable)", () => {
    expect(evaluatePromotions({ perf: recs(10, { pools: 1 }), cfg: CFG })).toEqual([]);
  });

  it("losing/low-winrate pattern → rejected", () => {
    expect(evaluatePromotions({ perf: recs(10, { pnl: -1 }), cfg: CFG })).toEqual([]);
  });

  it("clears the bar across pools → one ranked finding with evidence", () => {
    const out = evaluatePromotions({ perf: recs(8, { pools: 4 }), cfg: CFG });
    expect(out).toHaveLength(1);
    const f = out[0];
    expect(f.n).toBe(8);
    expect(f.pools).toBe(4);
    expect(f.winRate).toBe(100);
    expect(f.suggestedRule).toContain('strategy="spot"');
    expect(f.suggestedRule).toContain("bin_step=80");
    expect(f.reasons.length).toBeGreaterThanOrEqual(5);
    expect(f.sig).toBe(sigOf(patternKey(recs(1)[0])));
  });

  it("already-handled signature is excluded", () => {
    const sig = sigOf(patternKey(recs(1)[0]));
    const out = evaluatePromotions({
      perf: recs(8, { pools: 4 }),
      alreadyHandled: new Set([sig]),
      cfg: CFG,
    });
    expect(out).toEqual([]);
  });

  it("main already has a lesson for this strategy+bin_step → deduped out", () => {
    const out = evaluatePromotions({
      perf: recs(8, { pools: 4 }),
      mainLessons: [{ rule: 'PREFER: strategy="spot" on bin_step=80, volatility 2-4 pools — prior.' }],
      cfg: CFG,
    });
    expect(out).toEqual([]);
  });

  it("ranks stronger (higher net PnL) patterns first", () => {
    const weak = recs(5, { strategy: "curve", bin: 100, pnl: 1, pools: 3 });
    const strong = recs(6, { strategy: "spot", bin: 80, pnl: 5, pools: 3 });
    const out = evaluatePromotions({ perf: [...weak, ...strong], cfg: CFG });
    expect(out).toHaveLength(2);
    expect(out[0].strategy).toBe("spot");
    expect(out[0].totalPnlUsd).toBeGreaterThan(out[1].totalPnlUsd);
  });
});
