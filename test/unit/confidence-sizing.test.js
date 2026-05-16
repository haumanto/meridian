// confidenceSizeMultiplier scales a real deploy's SOL size, so the
// default-off (=1, zero change) and the brand-new / proven / weak
// boundaries are what matter. Gentle 3-state curve.

import { describe, it, expect, beforeAll } from "vitest";

let confidenceSizeMultiplier;
beforeAll(async () => {
  ({ confidenceSizeMultiplier } = await import("../../confidence-sizing.js"));
});

const ON = {
  confidenceSizingEnabled: true,
  confidenceFirstDeployMult: 0.7,
  confidenceFloorMult: 0.5,
  confidenceFullWinRate: 60,
  confidenceMinSamples: 3,
};

describe("confidenceSizeMultiplier", () => {
  it("disabled / no cfg → 1 (zero behavior change)", () => {
    expect(confidenceSizeMultiplier({ adjustedWinRate: 0, sampleCount: 0, cfg: undefined })).toBe(1);
    expect(confidenceSizeMultiplier({ adjustedWinRate: 100, sampleCount: 99, cfg: { confidenceSizingEnabled: false } })).toBe(1);
  });

  it("brand-new pool (no samples) → first-deploy multiplier (0.7)", () => {
    expect(confidenceSizeMultiplier({ adjustedWinRate: 0, sampleCount: 0, cfg: ON })).toBe(0.7);
  });

  it("samples below minimum → first-deploy multiplier even if WR looks great", () => {
    // 100% adjWR over 2 samples is statistically meaningless → still 0.7
    expect(confidenceSizeMultiplier({ adjustedWinRate: 100, sampleCount: 2, cfg: ON })).toBe(0.7);
  });

  it("enough samples AND adjusted WR ≥ full → full size (1.0)", () => {
    expect(confidenceSizeMultiplier({ adjustedWinRate: 60, sampleCount: 3, cfg: ON })).toBe(1);
    expect(confidenceSizeMultiplier({ adjustedWinRate: 85, sampleCount: 10, cfg: ON })).toBe(1);
  });

  it("enough samples BUT WR below full → floor (0.5)", () => {
    expect(confidenceSizeMultiplier({ adjustedWinRate: 59, sampleCount: 4, cfg: ON })).toBe(0.5);
    expect(confidenceSizeMultiplier({ adjustedWinRate: 0, sampleCount: 8, cfg: ON })).toBe(0.5);
  });

  it("result is clamped to [floor, 1]", () => {
    const cfg = { ...ON, confidenceFirstDeployMult: 9, confidenceFloorMult: 0.5 }; // absurd first mult
    expect(confidenceSizeMultiplier({ adjustedWinRate: 0, sampleCount: 0, cfg })).toBe(1); // clamped down
    const cfg2 = { ...ON, confidenceFirstDeployMult: -3 };
    expect(confidenceSizeMultiplier({ adjustedWinRate: 0, sampleCount: 0, cfg: cfg2 })).toBe(0.5); // clamped up to floor
  });

  it("non-finite inputs are treated as insufficient evidence (→ first)", () => {
    expect(confidenceSizeMultiplier({ adjustedWinRate: null, sampleCount: NaN, cfg: ON })).toBe(0.7);
    expect(confidenceSizeMultiplier({ adjustedWinRate: "x", sampleCount: 5, cfg: ON })).toBe(0.5); // samples ok, WR junk → not proven
  });

  it("honors custom thresholds", () => {
    const cfg = { ...ON, confidenceFullWinRate: 75, confidenceMinSamples: 5 };
    expect(confidenceSizeMultiplier({ adjustedWinRate: 70, sampleCount: 6, cfg })).toBe(0.5); // 70 < 75
    expect(confidenceSizeMultiplier({ adjustedWinRate: 80, sampleCount: 6, cfg })).toBe(1);
    expect(confidenceSizeMultiplier({ adjustedWinRate: 90, sampleCount: 4, cfg })).toBe(0.7); // samples < 5
  });
});
