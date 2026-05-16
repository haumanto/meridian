// The /optimize headless run is report-only; every tap-to-apply is
// re-validated HERE before update_config (the real safety net, independent
// of the LLM). Cover allowlist, the ≤30% magnitude cap, sign/range sanity,
// coercion, and the recommendations-file loader.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  validateRecommendation,
  loadLatestRecommendations,
  APPLYABLE_KEYS,
} from "../../optimize-apply.js";

const liveConfig = {
  screening: { minOrganic: 65, maxBinStep: 150, minMcap: 50000, maxBundlePct: 35, maxBotHoldersPct: 35, maxTop10Pct: 65 },
  management: { stopLossPct: -25, takeProfitPct: 8, positionSizePct: 0.6, gasReserve: 0.2, deployAmountSol: 0.75, minFeePerTvl24h: 0.5, outOfRangeBinsToClose: 3 },
  risk: { maxPositions: 4, maxDeploysPerDay: 30 },
  schedule: { screeningIntervalMin: 30 },
  indicators: { rsiLength: 14, rsiOversold: 30, rsiOverbought: 70 },
};

describe("validateRecommendation", () => {
  it("accepts an in-allowlist key within 30% and returns the coerced value", () => {
    const r = validateRecommendation({ key: "minOrganic", proposed: "78" }, liveConfig);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(78);
    expect(r.section).toBe("screening");
    expect(r.current).toBe(65);
  });

  it("rejects keys not in the allowlist", () => {
    const r = validateRecommendation({ key: "emergencyStop", proposed: true }, liveConfig);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/allowlist/);
  });

  it("rejects a change exceeding the 30% magnitude cap", () => {
    // 65 -> 90 is +38%
    const r = validateRecommendation({ key: "minOrganic", proposed: 90 }, liveConfig);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/30%/);
  });

  it("allows exactly ~30% and just over the boundary fails", () => {
    expect(validateRecommendation({ key: "maxDeploysPerDay", proposed: 39 }, liveConfig).ok).toBe(true); // +30%
    expect(validateRecommendation({ key: "maxDeploysPerDay", proposed: 40 }, liveConfig).ok).toBe(false); // +33%
  });

  it("enforces sign/range sanity", () => {
    expect(validateRecommendation({ key: "stopLossPct", proposed: 5 }, liveConfig).ok).toBe(false); // must be <0
    expect(validateRecommendation({ key: "stopLossPct", proposed: -22 }, liveConfig).ok).toBe(true);
    expect(validateRecommendation({ key: "takeProfitPct", proposed: -1 }, liveConfig).ok).toBe(false);
    expect(validateRecommendation({ key: "positionSizePct", proposed: 0.7 }, liveConfig).ok).toBe(true);
    expect(validateRecommendation({ key: "positionSizePct", proposed: 1.5 }, liveConfig).ok).toBe(false);
    expect(validateRecommendation({ key: "maxPositions", proposed: 4.5 }, liveConfig).ok).toBe(false); // non-int
    expect(validateRecommendation({ key: "maxPositions", proposed: 5 }, liveConfig).ok).toBe(true);
  });

  it("rejects non-finite proposals and malformed recs", () => {
    expect(validateRecommendation({ key: "minOrganic", proposed: "abc" }, liveConfig).ok).toBe(false);
    expect(validateRecommendation(null, liveConfig).ok).toBe(false);
    expect(validateRecommendation({ proposed: 1 }, liveConfig).ok).toBe(false);
  });

  it("uses live config (not rec.current) for the magnitude baseline", () => {
    // rec lies (current:10) to disguise a big move. Baseline must be the
    // live value (maxBinStep=150), so 150→110 (26.7%) passes …
    const r = validateRecommendation({ key: "maxBinStep", current: 10, proposed: 110 }, liveConfig);
    expect(r.ok).toBe(true);
    expect(r.current).toBe(150);
    // … and 150→90 (40%) is rejected despite the spoofed current:10.
    const r2 = validateRecommendation({ key: "maxBinStep", current: 10, proposed: 90 }, liveConfig);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toMatch(/30%/);
  });

  it("APPLYABLE_KEYS spans screening + risk/mgmt/schedule + new keys", () => {
    for (const k of ["minOrganic", "stopLossPct", "maxDeploysPerDay", "screeningIntervalMin",
      "minFeePerTvl24h", "outOfRangeBinsToClose", "rsiOversold", "rsiOverbought", "rsiLength"]) {
      expect(APPLYABLE_KEYS.has(k)).toBe(true);
    }
  });

  it("tighten-only: protective rug filters cannot be loosened (raised)", () => {
    // maxBundlePct 35 -> 40 loosens (allows MORE bundling) → reject.
    const loosen = validateRecommendation({ key: "maxBundlePct", proposed: 40 }, liveConfig);
    expect(loosen.ok).toBe(false);
    expect(loosen.reason).toMatch(/LOOSEN|tighten-only/);
    // 35 -> 30 tightens (stricter) → allowed.
    expect(validateRecommendation({ key: "maxBundlePct", proposed: 30 }, liveConfig).ok).toBe(true);
    // same for the other two
    expect(validateRecommendation({ key: "maxBotHoldersPct", proposed: 40 }, liveConfig).ok).toBe(false);
    expect(validateRecommendation({ key: "maxTop10Pct", proposed: 60 }, liveConfig).ok).toBe(true);
  });

  it("minFeePerTvl24h: numeric, within cap; negatives rejected", () => {
    expect(validateRecommendation({ key: "minFeePerTvl24h", proposed: 0.55 }, liveConfig).ok).toBe(true); // +10%
    // empty config → no baseline → magnitude skipped, so the sign rule is what bites
    expect(validateRecommendation({ key: "minFeePerTvl24h", proposed: -1 }, {}).ok).toBe(false);
  });

  // Empty config (no baseline) isolates the integer/range rules from the
  // 30% magnitude cap, which would otherwise mask them.
  it("outOfRangeBinsToClose: integer ≥ 1", () => {
    expect(validateRecommendation({ key: "outOfRangeBinsToClose", proposed: 4 }, {}).ok).toBe(true);
    expect(validateRecommendation({ key: "outOfRangeBinsToClose", proposed: 3.5 }, {}).ok).toBe(false);
    expect(validateRecommendation({ key: "outOfRangeBinsToClose", proposed: 0 }, {}).ok).toBe(false);
  });

  it("RSI thresholds: range/integer sanity", () => {
    expect(validateRecommendation({ key: "rsiLength", proposed: 16 }, liveConfig).ok).toBe(true); // +14%
    expect(validateRecommendation({ key: "rsiLength", proposed: 1.5 }, {}).ok).toBe(false); // non-int
    expect(validateRecommendation({ key: "rsiLength", proposed: 1 }, {}).ok).toBe(false); // <2
    expect(validateRecommendation({ key: "rsiOversold", proposed: 35 }, liveConfig).ok).toBe(true); // +16.7%
    expect(validateRecommendation({ key: "rsiOverbought", proposed: 150 }, {}).ok).toBe(false); // ≥100
    expect(validateRecommendation({ key: "rsiOversold", proposed: 0 }, {}).ok).toBe(false); // ≤0
  });
});

describe("loadLatestRecommendations", () => {
  let tmpdir, file;
  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-rec-"));
    file = path.join(tmpdir, "latest-recommendations.json");
  });
  afterEach(() => fs.rmSync(tmpdir, { recursive: true, force: true }));

  it("returns null when the file is missing", () => {
    expect(loadLatestRecommendations(file)).toBeNull();
  });

  it("returns null on corrupt JSON instead of throwing", () => {
    fs.writeFileSync(file, "{not json");
    expect(loadLatestRecommendations(file)).toBeNull();
  });

  it("returns null when recommendations is not an array", () => {
    fs.writeFileSync(file, JSON.stringify({ recommendations: "nope" }));
    expect(loadLatestRecommendations(file)).toBeNull();
  });

  it("parses a well-formed file", () => {
    fs.writeFileSync(file, JSON.stringify({
      generated_at: "2026-05-16T00:00:00Z",
      mode: "report-only",
      recommendations: [{ key: "minOrganic", proposed: 78 }],
    }));
    const d = loadLatestRecommendations(file);
    expect(d.recommendations).toHaveLength(1);
    expect(d.recommendations[0].key).toBe("minOrganic");
  });
});
