// evaluateWhaleDump is a money-path gate (it auto-closes positions), so
// the false-positive boundaries matter most: a big BUY spike, a broad
// organic selloff, and missing data must all NOT fire.

import { describe, it, expect, beforeAll } from "vitest";

let evaluateWhaleDump;
beforeAll(async () => {
  ({ evaluateWhaleDump } = await import("../../whale-detector.js"));
});

const CFG = { whaleDumpPriceDropPct: 12, whaleVolumeSpikePct: 150, whaleMinAvgTradeUsd: 3000 };

describe("evaluateWhaleDump", () => {
  it("fires on crash + volume spike + whale concentration", () => {
    const r = evaluateWhaleDump(
      { pool_price_change_pct: -22, volume_change_pct: 240, volume: 60000, unique_traders: 5 },
      CFG,
    );
    expect(r.dump).toBe(true);
    expect(r.reason).toMatch(/-22%/);
    expect(r.metrics.avg_trade_usd).toBe(12000);
  });

  it("does NOT fire on a big BUY spike (price up — direction gate)", () => {
    const r = evaluateWhaleDump(
      { pool_price_change_pct: 35, volume_change_pct: 400, volume: 80000, unique_traders: 4 },
      CFG,
    );
    expect(r.dump).toBe(false);
  });

  it("does NOT fire on a broad organic selloff (many traders, low avg)", () => {
    const r = evaluateWhaleDump(
      { pool_price_change_pct: -20, volume_change_pct: 200, volume: 50000, unique_traders: 400 },
      CFG, // avg = 125 << 3000
    );
    expect(r.dump).toBe(false);
  });

  it("does NOT fire below the price-drop threshold", () => {
    const r = evaluateWhaleDump(
      { pool_price_change_pct: -8, volume_change_pct: 300, volume: 60000, unique_traders: 3 },
      CFG,
    );
    expect(r.dump).toBe(false);
  });

  it("does NOT fire below the volume-spike threshold", () => {
    const r = evaluateWhaleDump(
      { pool_price_change_pct: -25, volume_change_pct: 100, volume: 60000, unique_traders: 3 },
      CFG,
    );
    expect(r.dump).toBe(false);
  });

  it("fails safe on missing / null / garbage detail", () => {
    expect(evaluateWhaleDump(null, CFG).dump).toBe(false);
    expect(evaluateWhaleDump(undefined, CFG).dump).toBe(false);
    expect(evaluateWhaleDump("nope", CFG).dump).toBe(false);
    expect(evaluateWhaleDump({ volume: 1 }, CFG).dump).toBe(false); // no price/vol change
    expect(evaluateWhaleDump({ pool_price_change_pct: -50, volume_change_pct: 999 }, CFG).dump).toBe(false); // no volume
  });

  it("accepts condensed field-name fallbacks", () => {
    const r = evaluateWhaleDump(
      { price_change_pct: -30, volume_change_pct: 220, volume_window: 90000, unique_traders: 6 },
      CFG,
    );
    expect(r.dump).toBe(true);
  });

  it("falls back to swap_count when unique_traders is absent", () => {
    const r = evaluateWhaleDump(
      { pool_price_change_pct: -18, volume_change_pct: 180, volume: 40000, swap_count: 4 },
      CFG, // avg = 10000
    );
    expect(r.dump).toBe(true);
  });

  it("no concentration denominator → no fire", () => {
    const r = evaluateWhaleDump(
      { pool_price_change_pct: -40, volume_change_pct: 500, volume: 99999 },
      CFG, // no traders, no swaps
    );
    expect(r.dump).toBe(false);
  });

  it("respects custom thresholds", () => {
    const detail = { pool_price_change_pct: -15, volume_change_pct: 160, volume: 50000, unique_traders: 10 };
    expect(evaluateWhaleDump(detail, CFG).dump).toBe(true); // avg 5000 ≥ 3000
    expect(evaluateWhaleDump(detail, { ...CFG, whaleMinAvgTradeUsd: 8000 }).dump).toBe(false);
    expect(evaluateWhaleDump(detail, { ...CFG, whaleDumpPriceDropPct: 20 }).dump).toBe(false);
  });

  it("uses safe defaults when cfg omitted", () => {
    // defaults: drop 12, spike 150, avg 3000
    expect(evaluateWhaleDump({ pool_price_change_pct: -13, volume_change_pct: 151, volume: 30000, unique_traders: 5 }).dump).toBe(true);
    expect(evaluateWhaleDump({ pool_price_change_pct: -5, volume_change_pct: 151, volume: 30000, unique_traders: 5 }).dump).toBe(false);
  });
});
