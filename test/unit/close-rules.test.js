// Deterministic close-rule table. Rules 1,2,3,4,5 must behave exactly
// as the pre-extraction inline logic; 3b/4b are the new symmetric
// below-range exits. Pure fn → exhaustive table, no I/O.

import { describe, it, expect } from "vitest";
import { getDeterministicCloseRule } from "../../close-rules.js";

const CFG = {
  stopLossPct: -50,
  takeProfitPct: 5,
  outOfRangeBinsToClose: 10,
  outOfRangeWaitMinutes: 30,
  minFeePerTvl24h: 7,
};
// active inside [lower,upper], healthy → no rule
const base = {
  pair: "X-SOL",
  pnl_pct: 1,
  total_value_usd: 100,
  active_bin: -100,
  lower_bin: -135,
  upper_bin: -100,
  minutes_out_of_range: 0,
  fee_per_tvl_24h: 50,
  age_minutes: 120,
};
const R = (over) => getDeterministicCloseRule({ ...base, ...over }, CFG, 1);

describe("getDeterministicCloseRule — existing rules unchanged", () => {
  it("in-range healthy → null (no close)", () => {
    expect(R({})).toBeNull();
  });
  it("Rule 1: stop loss (pnl <= stopLossPct)", () => {
    expect(R({ pnl_pct: -50 })).toEqual({ action: "CLOSE", rule: 1, reason: "stop loss" });
    expect(R({ pnl_pct: -60 })).toMatchObject({ rule: 1 });
  });
  it("Rule 2: take profit (pnl >= takeProfitPct)", () => {
    expect(R({ pnl_pct: 5 })).toEqual({ action: "CLOSE", rule: 2, reason: "take profit" });
  });
  it("Rule 3: pumped far above range", () => {
    expect(R({ active_bin: -100 + 11, upper_bin: -100 })).toMatchObject({ rule: 3, reason: "pumped far above range" });
  });
  it("Rule 4: OOR above after wait", () => {
    expect(R({ active_bin: -99, upper_bin: -100, minutes_out_of_range: 30 })).toMatchObject({ rule: 4, reason: "OOR" });
    // above but not yet waited → no rule 4
    expect(R({ active_bin: -99, upper_bin: -100, minutes_out_of_range: 29, pnl_pct: 1, fee_per_tvl_24h: 50 })).toBeNull();
  });
  it("Rule 5: low yield after 60m", () => {
    expect(R({ fee_per_tvl_24h: 6, age_minutes: 60 })).toMatchObject({ rule: 5, reason: "low yield" });
    expect(R({ fee_per_tvl_24h: 6, age_minutes: 59 })).toBeNull();
  });
  it("pnlSuspect: <=-90% but still has value & tracked size → skips PnL rules (no rule 1)", () => {
    // suspect → stop-loss/TP suppressed; geometry healthy → null
    expect(getDeterministicCloseRule({ ...base, pnl_pct: -95, total_value_usd: 100 }, CFG, 1)).toBeNull();
    // no tracked size → not suspect → rule 1 fires
    expect(getDeterministicCloseRule({ ...base, pnl_pct: -95 }, CFG, undefined)).toMatchObject({ rule: 1 });
  });
});

describe("getDeterministicCloseRule — new below-range rules", () => {
  it("Rule 3b: crashed far below range (immediate)", () => {
    expect(R({ active_bin: -135 - 11, lower_bin: -135 }))
      .toEqual({ action: "CLOSE", rule: "3b", reason: "crashed far below range" });
  });
  it("Rule 4b: OOR below after wait; not before", () => {
    expect(R({ active_bin: -136, lower_bin: -135, minutes_out_of_range: 30 }))
      .toEqual({ action: "CLOSE", rule: "4b", reason: "OOR (below range)" });
    expect(R({ active_bin: -136, lower_bin: -135, minutes_out_of_range: 29 })).toBeNull();
  });
  it("just below by <bins threshold and not yet waited → no close (still null)", () => {
    expect(R({ active_bin: -140, lower_bin: -135, minutes_out_of_range: 5 })).toBeNull();
  });
  it("in-range and above-range positions are unaffected by the below rules", () => {
    expect(R({ active_bin: -110 })).toBeNull(); // inside [-135,-100]
    expect(R({ active_bin: -95, upper_bin: -100, minutes_out_of_range: 1 })).toBeNull(); // above, pre-wait
  });
  it("stop-loss still takes precedence over below-range geometry", () => {
    expect(R({ pnl_pct: -55, active_bin: -200, lower_bin: -135 })).toMatchObject({ rule: 1 });
  });
});
