// Apply-side of the Telegram /optimize flow. The headless Claude run is
// REPORT-ONLY: it writes optimization-reports/latest-recommendations.json
// and never edits config. The operator then taps inline buttons; each tap
// is validated HERE (independent of the LLM — this is the real safety net)
// and applied via the same executeTool("update_config", …) path /setcfg
// uses. Pure + filesystem-only so it's unit-testable.

import fs from "fs";

export const RECOMMENDATIONS_FILE = "./optimization-reports/latest-recommendations.json";

// key -> config section. Union of the optimize-meridian skill's auto-edit
// allowlist (screening) and its normally "recommendation-only" risk/mgmt
// keys — every entry verified present in tools/executor.js update_config
// keyMap. emergencyStop / model / strategy keys are intentionally excluded.
export const KEY_SECTION = {
  // screening allowlist
  minTvl: "screening", maxTvl: "screening", minVolume: "screening",
  minOrganic: "screening", minQuoteOrganic: "screening", minHolders: "screening",
  minMcap: "screening", maxMcap: "screening", minBinStep: "screening",
  maxBinStep: "screening", minFeeActiveTvlRatio: "screening",
  minTokenFeesSol: "screening", maxBundlePct: "screening",
  maxBotHoldersPct: "screening", maxTop10Pct: "screening",
  minTokenAgeHours: "screening", maxTokenAgeHours: "screening",
  athFilterPct: "screening", minFeePerTvl24h: "management",
  // recommendation-only risk / management / schedule
  stopLossPct: "management", takeProfitPct: "management",
  trailingTriggerPct: "management", trailingDropPct: "management",
  outOfRangeWaitMinutes: "management", outOfRangeBinsToClose: "management",
  deployAmountSol: "management", positionSizePct: "management",
  minSolToOpen: "management", gasReserve: "management",
  maxPositions: "risk", maxDeployAmount: "risk",
  maxDeploysPerHour: "risk", maxDeploysPerDay: "risk",
  screeningIntervalMin: "schedule", managementIntervalMin: "schedule",
  // entry/exit signal thresholds (only meaningful when chartIndicators on)
  rsiOversold: "indicators", rsiOverbought: "indicators", rsiLength: "indicators",
};

export const APPLYABLE_KEYS = new Set(Object.keys(KEY_SECTION));

// Anti-rug protective ceilings: a *lower* value is stricter. The optimizer
// (or a hallucinated rec) must never autonomously LOOSEN these to chase
// fees from tokens that paid out right before rugging — tighten-only.
export const TIGHTEN_ONLY_KEYS = new Set(["maxBundlePct", "maxBotHoldersPct", "maxTop10Pct"]);

const MAX_MAGNITUDE_PCT = 0.30; // skill hard limit: ≤30% change per key
const EPS = 1e-9;

export function loadLatestRecommendations(file = RECOMMENDATIONS_FILE) {
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || !Array.isArray(data.recommendations)) return null;
    return data;
  } catch {
    return null;
  }
}

// Live current value for a key (from the in-process config object), used
// for the magnitude cap and the button label. Falls back to rec.current.
export function currentValue(key, liveConfig, fallback) {
  const section = KEY_SECTION[key];
  const v = section && liveConfig?.[section]?.[key];
  return v == null ? fallback : v;
}

// Returns { ok, reason, value, section, current }. `value` is the coerced
// number to hand to update_config. Rejects anything outside the allowlist,
// any >30% magnitude move, or values that fail sign/range sanity (mirrors
// config.js validateBoot).
export function validateRecommendation(rec, liveConfig) {
  if (!rec || typeof rec.key !== "string") {
    return { ok: false, reason: "malformed recommendation" };
  }
  const key = rec.key;
  if (!APPLYABLE_KEYS.has(key)) {
    return { ok: false, reason: `${key} is not in the applyable allowlist` };
  }
  const section = KEY_SECTION[key];
  const proposed = Number(rec.proposed);
  if (!Number.isFinite(proposed)) {
    return { ok: false, reason: `proposed value for ${key} is not a finite number` };
  }
  const current = currentValue(key, liveConfig, Number(rec.current));

  // Tighten-only guard for protective rug filters (lower = stricter).
  if (TIGHTEN_ONLY_KEYS.has(key) && Number.isFinite(current) && proposed > current + EPS) {
    return {
      ok: false,
      reason: `${key}: ${current}→${proposed} would LOOSEN a protective rug filter (tighten-only)`,
      current,
    };
  }

  // Magnitude cap (only when we have a non-zero numeric baseline).
  if (Number.isFinite(current) && Math.abs(current) > EPS) {
    const pct = Math.abs(proposed - current) / Math.abs(current);
    if (pct > MAX_MAGNITUDE_PCT + EPS) {
      return {
        ok: false,
        reason: `${key}: ${current}→${proposed} is ${(pct * 100).toFixed(0)}% (>30% cap)`,
        current,
      };
    }
  }

  const fail = (msg) => ({ ok: false, reason: `${key}: ${msg}`, current });
  const isInt = Number.isInteger(proposed);
  switch (key) {
    case "stopLossPct":
      if (proposed >= 0) return fail("must be negative");
      break;
    case "takeProfitPct":
    case "trailingTriggerPct":
    case "trailingDropPct":
      if (proposed <= 0) return fail("must be positive");
      break;
    case "positionSizePct":
      if (proposed <= 0 || proposed > 1) return fail("must be in (0, 1]");
      break;
    case "gasReserve":
    case "outOfRangeWaitMinutes":
      if (proposed < 0) return fail("must be ≥ 0");
      break;
    case "deployAmountSol":
    case "maxDeployAmount":
    case "minSolToOpen":
      if (proposed <= 0) return fail("must be positive");
      break;
    case "maxPositions":
    case "maxDeploysPerHour":
    case "maxDeploysPerDay":
    case "screeningIntervalMin":
    case "managementIntervalMin":
    case "outOfRangeBinsToClose":
      if (!isInt || proposed < 1) return fail("must be an integer ≥ 1");
      break;
    case "rsiLength":
      if (!isInt || proposed < 2) return fail("must be an integer ≥ 2");
      break;
    case "rsiOversold":
    case "rsiOverbought":
      if (proposed <= 0 || proposed >= 100) return fail("must be within (0, 100)");
      break;
    default:
      // Generic min/threshold keys (incl. minFeePerTvl24h): no negatives.
      if (proposed < 0) return fail("must be ≥ 0");
  }

  return { ok: true, value: proposed, section, current };
}
