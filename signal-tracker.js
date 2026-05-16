/**
 * signal-tracker.js — Stages screening signals for later attribution.
 *
 * Signals are staged at screen time (before the LLM decides) and
 * retrieved when the position closes (recordPerformance), so the exact
 * screening conditions are persisted into the performance record and
 * Darwin signal weighting has real inputs. Indexed by pool address AND
 * base mint — the close path may only know one of them.
 */

const _staged = new Map();           // poolAddress -> { ...signals, base_mint, staged_at }
const _stagedByBaseMint = new Map(); // baseMint -> poolAddress
const STAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function normalizeKey(v) {
  const s = v == null ? "" : String(v).trim();
  return s || null;
}

function cleanupStale() {
  const now = Date.now();
  for (const [addr, data] of _staged) {
    if (now - data.staged_at > STAGE_TTL_MS) {
      _staged.delete(addr);
      if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === addr) {
        _stagedByBaseMint.delete(data.base_mint);
      }
    }
  }
}

/**
 * Stage signals for a pool during screening. `signals.base_mint` (when
 * present) is also indexed so the close path can retrieve by token.
 * @param {string} poolAddress
 * @param {object} signals — { base_mint, organic_score, fee_tvl_ratio, volume, mcap, holder_count, smart_wallets_present, narrative_quality, study_win_rate, hive_consensus, volatility }
 */
export function stageSignals(poolAddress, signals) {
  const poolKey = normalizeKey(poolAddress);
  if (!poolKey) return;
  const baseMint = normalizeKey(signals?.base_mint);
  _staged.set(poolKey, { ...signals, base_mint: baseMint, staged_at: Date.now() });
  if (baseMint) _stagedByBaseMint.set(baseMint, poolKey);
  cleanupStale();
}

/**
 * Retrieve AND clear staged signals for a pool. Falls back to a
 * base-mint lookup when the pool address doesn't match (e.g. a different
 * pool of the same token). Returns the staged signals (without
 * `staged_at`) or null. Clears both indexes.
 */
export function getAndClearStagedSignals(poolAddress, baseMint = null) {
  cleanupStale();
  let poolKey = normalizeKey(poolAddress);
  let data = poolKey ? _staged.get(poolKey) : null;

  if (!data && baseMint) {
    const baseKey = normalizeKey(baseMint);
    poolKey = baseKey ? _stagedByBaseMint.get(baseKey) : null;
    data = poolKey ? _staged.get(poolKey) : null;
  }
  if (!data) return null;

  _staged.delete(poolKey);
  if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === poolKey) {
    _stagedByBaseMint.delete(data.base_mint);
  }
  const { staged_at, ...signals } = data; // eslint-disable-line no-unused-vars
  return signals;
}
