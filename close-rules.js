// Deterministic close rules — pure decision logic (no I/O), extracted
// from index.js so it is unit-testable, mirroring the testable-helper
// pattern (whale-detector.js, strategy-selector.js, confidence-sizing.js,
// autoresearch-guard.js). index.js does the getTrackedPosition lookup
// and passes trackedAmountSol so this stays pure.
//
// Rules 1,2,3,4,5 are the original logic verbatim. Rules 3b/4b add the
// previously-missing BELOW-range exits, symmetric to the ABOVE-range
// 3/4 (single-sided SOL deployed below active: if price crashes through
// the entire downside range the position is 100% base token earning
// zero fees — the same dead-OOR state Rule 4 recycles when above).

export function getDeterministicCloseRule(position, managementConfig, trackedAmountSol) {
  const pnlSuspect = (() => {
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (trackedAmountSol && (position.total_value_usd ?? 0) > 0.01) {
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  // Below-range, symmetric to Rules 3/4. minutes_out_of_range is
  // direction-agnostic (state.js sets out_of_range_since from the
  // on-chain in_range flag regardless of side).
  if (
    position.active_bin != null &&
    position.lower_bin != null &&
    position.active_bin < position.lower_bin - managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: "3b", reason: "crashed far below range" };
  }
  if (
    position.active_bin != null &&
    position.lower_bin != null &&
    position.active_bin < position.lower_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: "4b", reason: "OOR (below range)" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}
