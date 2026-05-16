/**
 * whale-detector.js — pure dump-in-progress signal.
 *
 * The Meteora API has no per-trade/mempool feed, so we can't pre-empt an
 * unsubmitted sell. This detects the SIGNATURE of a whale dump already
 * in progress from aggregate pool stats so the 30s poller can exit far
 * earlier than the reactive rules (stop-loss / OOR / trailing).
 *
 * Strong, price-direction-gated, multi-factor — ALL of:
 *   1. price crashing  (gates out big BUY spikes — those have +price)
 *   2. volume spiking   (something big is happening)
 *   3. whale concentration: large avg trade size = few big actors, not
 *      a broad organic selloff
 * Missing/garbage data → no dump (fail safe; never close on bad input).
 *
 * Pure — no I/O — so it's unit-testable.
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Accept raw Meteora field names (getPoolDetail returns the raw pool
// object) with condensed-name fallbacks for robustness/testing.
function pick(detail, ...keys) {
  for (const k of keys) {
    const v = num(detail?.[k]);
    if (v != null) return v;
  }
  return null;
}

export function evaluateWhaleDump(detail, cfg = {}) {
  const fail = (reason) => ({ dump: false, reason, metrics: null });
  if (!detail || typeof detail !== "object") return fail("no pool detail");

  const priceChangePct = pick(detail, "pool_price_change_pct", "price_change_pct");
  const volumeChangePct = pick(detail, "volume_change_pct");
  const volume = pick(detail, "volume", "volume_window");
  const traders = pick(detail, "unique_traders");
  const swaps = pick(detail, "swap_count");

  if (priceChangePct == null || volumeChangePct == null || volume == null) {
    return fail("insufficient pool stats");
  }

  const dropPct = Number(cfg.whaleDumpPriceDropPct ?? 12);
  const volSpikePct = Number(cfg.whaleVolumeSpikePct ?? 150);
  const minAvgTradeUsd = Number(cfg.whaleMinAvgTradeUsd ?? 3000);

  // Concentration: average trade size in the window. Prefer traders;
  // fall back to swap_count. If neither is usable we cannot establish
  // "whale" (vs broad flow) → don't fire.
  const denom = (traders != null && traders > 0) ? traders
    : (swaps != null && swaps > 0) ? swaps
      : null;
  const avgTradeUsd = denom != null ? volume / denom : null;

  // 1. price crash — direction gate (must be negative; a buy spike has
  //    positive price_change_pct and is excluded here).
  const priceCrash = priceChangePct <= -Math.abs(dropPct);
  // 2. volume spike vs Meteora's own prior-window comparison.
  const volSpike = volumeChangePct >= volSpikePct;
  // 3. whale concentration.
  const concentrated = avgTradeUsd != null && avgTradeUsd >= minAvgTradeUsd;

  const metrics = {
    price_change_pct: priceChangePct,
    volume_change_pct: volumeChangePct,
    volume,
    unique_traders: traders,
    swap_count: swaps,
    avg_trade_usd: avgTradeUsd != null ? Math.round(avgTradeUsd) : null,
  };

  if (priceCrash && volSpike && concentrated) {
    return {
      dump: true,
      reason: `price ${priceChangePct}% / vol +${volumeChangePct}% / ` +
        `~$${metrics.avg_trade_usd}/trade over ${denom} ${traders != null ? "traders" : "swaps"}`,
      metrics,
    };
  }
  return {
    dump: false,
    reason: `no dump (crash=${priceCrash} spike=${volSpike} concentrated=${concentrated})`,
    metrics,
  };
}
