// resolveLpStrategy gates the LP shape on a real deploy, so the
// default-off (zero behavior change) and fail-safe (bad volatility →
// base, never silently change shape) paths are the ones that matter.

import { describe, it, expect, beforeAll } from "vitest";

let resolveLpStrategy;
beforeAll(async () => {
  ({ resolveLpStrategy } = await import("../../strategy-selector.js"));
});

const ON = { volBandEnabled: true, volBandThreshold: 3, volBandHighStrategy: "bid_ask" };

describe("resolveLpStrategy", () => {
  it("disabled / no cfg → base unchanged (zero behavior change)", () => {
    expect(resolveLpStrategy({ base: "spot", volatility: 9, cfg: undefined })).toBe("spot");
    expect(resolveLpStrategy({ base: "spot", volatility: 9, cfg: {} })).toBe("spot");
    expect(resolveLpStrategy({ base: "spot", volatility: 9, cfg: { volBandEnabled: false } })).toBe("spot");
  });

  it("enabled + volatility ≥ threshold → high strategy", () => {
    expect(resolveLpStrategy({ base: "spot", volatility: 3, cfg: ON })).toBe("bid_ask"); // boundary (≥)
    expect(resolveLpStrategy({ base: "spot", volatility: 7.5, cfg: ON })).toBe("bid_ask");
  });

  it("enabled + volatility < threshold → base", () => {
    expect(resolveLpStrategy({ base: "spot", volatility: 2.9, cfg: ON })).toBe("spot");
    expect(resolveLpStrategy({ base: "curve", volatility: 1, cfg: ON })).toBe("curve"); // base passthrough
  });

  it("fail safe: missing / non-finite / non-positive volatility → base", () => {
    for (const v of [null, undefined, NaN, "abc", 0, -2]) {
      expect(resolveLpStrategy({ base: "spot", volatility: v, cfg: ON })).toBe("spot");
    }
  });

  it("respects custom threshold", () => {
    const cfg = { ...ON, volBandThreshold: 5 };
    expect(resolveLpStrategy({ base: "spot", volatility: 4.9, cfg })).toBe("spot");
    expect(resolveLpStrategy({ base: "spot", volatility: 5, cfg })).toBe("bid_ask");
  });

  it("respects custom high strategy; invalid high → base", () => {
    expect(resolveLpStrategy({ base: "spot", volatility: 9, cfg: { ...ON, volBandHighStrategy: "curve" } })).toBe("curve");
    expect(resolveLpStrategy({ base: "spot", volatility: 9, cfg: { ...ON, volBandHighStrategy: "weird" } })).toBe("spot");
  });

  it("guards a bad threshold (≤0 / NaN) → base", () => {
    expect(resolveLpStrategy({ base: "spot", volatility: 9, cfg: { ...ON, volBandThreshold: 0 } })).toBe("spot");
    expect(resolveLpStrategy({ base: "spot", volatility: 9, cfg: { ...ON, volBandThreshold: "x" } })).toBe("spot");
  });

  it("default threshold is 3 when omitted", () => {
    const cfg = { volBandEnabled: true, volBandHighStrategy: "bid_ask" }; // no threshold
    expect(resolveLpStrategy({ base: "spot", volatility: 3, cfg })).toBe("bid_ask");
    expect(resolveLpStrategy({ base: "spot", volatility: 2.5, cfg })).toBe("spot");
  });
});
