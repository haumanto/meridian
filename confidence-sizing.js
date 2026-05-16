/**
 * confidence-sizing.js — "start small, grow with evidence" position size.
 *
 * Tokens here get redeployed ~2.5× on average, so a familiarity-based
 * size multiplier genuinely graduates (it's not a hidden permanent cut).
 * First contact with an unproven pool is where rugs/snipers/instant
 * dumps live → deploy small; once the pool has a real track record
 * (adjusted win-rate over enough non-OOR samples), go full size. Capped
 * by maxDeployAmount as the hard "limitless" ceiling elsewhere.
 *
 * Gentle 3-state curve (no fragile interpolation), all /setcfg-tunable:
 *   - insufficient evidence (samples < minSamples, incl. brand-new) →
 *     firstDeployMult (default 0.7×)
 *   - enough samples AND adjustedWinRate ≥ fullWinRate → 1.0× (full)
 *   - enough samples BUT win-rate not good enough → floorMult (0.5×)
 * Result always clamped to [floorMult, 1].
 *
 * Pure — no I/O — unit-testable; the per-pool stats are read by the
 * caller from pool-memory (getPoolMemory) and passed in.
 */

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function confidenceSizeMultiplier({ adjustedWinRate, sampleCount, cfg } = {}) {
  if (!cfg || cfg.confidenceSizingEnabled !== true) return 1;

  const first = numOr(cfg.confidenceFirstDeployMult, 0.7);
  const floor = numOr(cfg.confidenceFloorMult, 0.5);
  const fullWR = numOr(cfg.confidenceFullWinRate, 60);   // adjusted_win_rate is 0–100
  const minS = numOr(cfg.confidenceMinSamples, 3);
  const clamp = (m) => Math.min(1, Math.max(floor, numOr(m, floor)));

  const s = Number(sampleCount);
  if (!Number.isFinite(s) || s < minS) return clamp(first); // brand-new / too little data
  const wr = Number(adjustedWinRate);
  if (Number.isFinite(wr) && wr >= fullWR) return 1;        // proven → full size
  return clamp(floor);                                      // has data, not good enough
}
