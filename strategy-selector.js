/**
 * strategy-selector.js — deterministic LP-shape selection.
 *
 * The screener LLM never varies LP shape (it just echoes the active
 * strategy), so there's no comparative data to optimize. This makes the
 * choice reproducible by pool volatility: when the vol-band selector is
 * enabled, pools at/above the threshold deploy as the configured high-
 * volatility strategy; everything else keeps the resolved base strategy.
 * Default OFF → zero behavior change.
 *
 * Pure — no I/O — so it's unit-testable and the resulting per-strategy
 * outcomes are a clean A/B (no LLM noise).
 */

const VALID = new Set(["spot", "bid_ask", "curve"]);

export function resolveLpStrategy({ base, volatility, cfg } = {}) {
  // Disabled (or no cfg) → exactly today's behavior.
  if (!cfg || cfg.volBandEnabled !== true) return base;

  // Fail safe: never silently change LP shape on missing/garbage
  // volatility (a real deploy separately refuses unusable volatility).
  const v = Number(volatility);
  if (!Number.isFinite(v) || v <= 0) return base;

  const threshold = Number(cfg.volBandThreshold ?? 3);
  if (!Number.isFinite(threshold) || threshold <= 0) return base;

  if (v >= threshold) {
    const high = cfg.volBandHighStrategy ?? "bid_ask";
    return VALID.has(high) ? high : base;
  }
  return base;
}
