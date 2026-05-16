// Darwin low-N robustness (Rec 2): per-signal floor — a lift is only
// computed when there are ≥3 winners AND ≥3 losers, so weights stay
// neutral on noise at the agent's real trade volume. Isolated via
// MERIDIAN_DATA_DIR + vi.resetModules so it never touches the live
// signal-weights.json (the proven-safe suite-isolation pattern).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

let tmpdir, recalculateWeights;
const nowISO = new Date().toISOString();
const rec = (pnl_usd, organic) => ({
  recorded_at: nowISO,
  pnl_usd,
  signal_snapshot: { organic_score: organic },
});

describe("recalculateWeights — per-signal ≥3/≥3 floor", () => {
  beforeEach(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-darwin-"));
    process.env.MERIDIAN_DATA_DIR = tmpdir;
    vi.resetModules();
    fs.mkdirSync(path.join(tmpdir, "logs"), { recursive: true });
    ({ recalculateWeights } = await import("../../signal-weights.js"));
  });
  afterEach(() => {
    delete process.env.MERIDIAN_DATA_DIR;
    vi.resetModules();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  const cfg = { darwin: { minSamples: 15, windowDays: 60 } };

  it("≥minSamples records but <3 winners → no weight changes (noise floor)", () => {
    // 2 wins + 13 losses = 15 recent (≥ minSamples) but only 2 winners
    const perf = [
      rec(5, 85), rec(5, 84),
      ...Array.from({ length: 13 }, () => rec(-3, 40)),
    ];
    const { changes } = recalculateWeights(perf, cfg);
    expect(changes).toEqual([]);
  });

  it("<minSamples records → no changes (existing window guard)", () => {
    const perf = Array.from({ length: 10 }, (_, i) => rec(i % 2 ? 5 : -3, i % 2 ? 85 : 40));
    expect(recalculateWeights(perf, cfg).changes).toEqual([]);
  });

  it("≥3 winners AND ≥3 losers with a separating signal → produces changes", () => {
    // 8 wins (organic 85) + 8 losses (organic 40) = 16 recent
    const perf = [
      ...Array.from({ length: 8 }, () => rec(5, 85)),
      ...Array.from({ length: 8 }, () => rec(-3, 40)),
    ];
    const { changes } = recalculateWeights(perf, cfg);
    expect(Array.isArray(changes)).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
  });
});
