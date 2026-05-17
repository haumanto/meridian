// Read-only autoresearch snapshot for the MAIN dashboard. The dashboard
// runs in the main process (paths bound to repo root); AR lives in an
// isolated profiles/autoresearch/ tree. This reads those files directly
// (atomic — AR writes via atomicWriteJson) and never touches the
// path-bound singletons. Pure aggregator (fs only), baseDir-injectable
// for tests — mirrors autoresearch-ledger.js / autoresearch-guard.js.
import fs from "fs";
import path from "path";
import { paths } from "./paths.js";
import { computeTodayRunLossSol, readArResults } from "./autoresearch-ledger.js";

const LIVENESS_MS = 5 * 60 * 1000; // lastUpdated fresher than this ⇒ "alive"

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const num = (v) => (Number.isFinite(v) ? v : null);

// Truest AR heartbeat: the isolated log file is appended every ~30s by
// the position poller, regardless of whether state.json changed (it's
// only rewritten on deltas — a stable in-range position can leave
// state.json untouched for 10+ min while AR is perfectly healthy).
// Returns newest agent-*.log mtime (ms) under <arDir>/logs, or NaN.
function latestLogMtime(arDir) {
  try {
    const dir = path.join(arDir, "logs");
    let newest = NaN;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith("agent-") || !f.endsWith(".log")) continue;
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (!Number.isFinite(newest) || m > newest) newest = m;
    }
    return newest;
  } catch {
    return NaN;
  }
}

// Read-only mirror of the promotion-advisor lifecycle for the dashboard.
// Reads AR's isolated promotions.json (under arDir — NOT paths.dataDir;
// in the dashboard process those differ) + the shared-root
// promotion-requests/ queue. Never throws, never writes, never drains
// (draining stays in main's mgmt cycle). Missing dirs → empties.
function buildPromotions(baseDir, arDir) {
  const empty = { pending: [], requested: [], applied: [], failedCount: 0 };
  try {
    const st = readJson(path.join(arDir, "promotions.json"), {});
    const alerted = st.alerted || {};
    const requestedTs = st.requested || {};
    const pendingObj = st.pending || {};
    const queueDir = path.join(baseDir, "promotion-requests");

    const pending = Object.values(pendingObj)
      .filter((f) => f && f.sig)
      .map((f) => ({ ...f, alertedAt: alerted[f.sig] || null }));

    const requested = [];
    try {
      for (const fn of fs.readdirSync(queueDir)) {
        if (!fn.endsWith(".json")) continue;
        const rec = readJson(path.join(queueDir, fn), null);
        if (!rec || !rec.sig) continue;
        requested.push({
          sig: rec.sig, patternKey: rec.patternKey, strategy: rec.strategy,
          binStep: rec.binStep, n: rec.n, pools: rec.pools, winRate: rec.winRate,
          totalPnlUsd: rec.totalPnlUsd, totalPnlSol: rec.totalPnlSol,
          suggestedRule: rec.suggestedRule,
          requestedAt: rec.requested_at || requestedTs[rec.sig] || null,
        });
      }
    } catch { /* queue dir absent — none requested */ }

    const applied = [];
    let failedCount = 0;
    try {
      for (const fn of fs.readdirSync(path.join(queueDir, "applied"))) {
        if (!fn.endsWith(".json")) continue;
        if (fn.startsWith("bad-")) { failedCount++; continue; }
        const rec = readJson(path.join(queueDir, "applied", fn), null);
        const tsPrefix = Number(fn.split("-")[0]);
        const appliedAt = Number.isFinite(tsPrefix) ? new Date(tsPrefix).toISOString() : null;
        applied.push({
          sig: rec?.sig || fn.replace(/\.json$/, ""),
          strategy: rec?.strategy || null, binStep: rec?.binStep ?? null,
          suggestedRule: rec?.suggestedRule || null, appliedAt,
        });
      }
    } catch { /* applied dir absent — none applied */ }
    applied.sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));

    return { pending, requested, applied: applied.slice(0, 20), failedCount };
  } catch {
    return empty;
  }
}

// Discover every AR run on disk. Each run = a profiles/autoresearch*
// dir with a state.json; its runId comes from that profile's
// user-config autoresearch.runId (fallback: legacy dir ⇒ run-001,
// else the dir suffix). Sorted by runId so run-001 is first/primary
// (keeps the single-run API back-compatible). Never throws.
export function discoverArRuns(baseDir = paths.root) {
  const profilesDir = path.join(baseDir, "profiles");
  const runs = [];
  let entries = [];
  try { entries = fs.readdirSync(profilesDir); } catch { return runs; }
  for (const name of entries) {
    if (!name.startsWith("autoresearch")) continue;
    const arDir = path.join(profilesDir, name);
    if (!fs.existsSync(path.join(arDir, "state.json"))) continue;
    const uc = readJson(path.join(arDir, "user-config.json"), {});
    const runId =
      uc.autoresearch?.runId ||
      (name === "autoresearch" ? "run-001" : name.replace(/^autoresearch[-_]?/, "") || name);
    runs.push({ runId: String(runId), arDir });
  }
  runs.sort((a, b) => a.runId.localeCompare(b.runId));
  return runs;
}

// Array of full snapshots, one per discovered run (sorted, run-001
// first). Each carries .runId so the dashboard can switch between them.
export function getArSnapshots(baseDir = paths.root) {
  return discoverArRuns(baseDir).map((r) => getArSnapshot(baseDir, r));
}

/**
 * @param {string} [baseDir] repo root (injectable for tests)
 * @param {{arDir:string,runId:string}|null} [runSel] specific run to
 *   snapshot; null ⇒ legacy primary (profiles/autoresearch / run-001),
 *   preserving the original single-run contract.
 * @returns {{configured:false} | {configured:true, ...snapshot}}
 */
export function getArSnapshot(baseDir = paths.root, runSel = null) {
  const arDir = runSel?.arDir || path.join(baseDir, "profiles", "autoresearch");
  const statePath = path.join(arDir, "state.json");
  if (!fs.existsSync(statePath)) return { configured: false };

  const state = readJson(statePath, {});
  const uc = readJson(path.join(arDir, "user-config.json"), {});
  const ar = uc.autoresearch || {};
  const runId =
    runSel?.runId || ar.runId || process.env.MERIDIAN_RESEARCH_RUN_ID || "run-001";
  const runCfg = readJson(
    path.join(baseDir, "research", "runs", String(runId), "config.json"),
    {},
  );

  const positionsObj = state.positions || {};
  const allPositions = Object.values(positionsObj);
  const open = allPositions
    .filter((p) => p && !p.closed)
    .map((p) => ({
      position: p.position,
      pool: p.pool,
      pool_name: p.pool_name,
      strategy: p.strategy,
      amount_sol: p.amount_sol,
      bin_range: p.bin_range,
      volatility: p.volatility,
      organic_score: p.organic_score,
      initial_value_usd: p.initial_value_usd,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      peak_pnl_pct: p.peak_pnl_pct,
    }));

  const lastUpdated = state.lastUpdated || null;
  const stateMs = lastUpdated ? Date.parse(lastUpdated) : NaN;
  const logMs = latestLogMtime(arDir);
  // Heartbeat = freshest of (log append, state write). Log is the 30s
  // poller signal; state write is the fallback when no logs dir (tests).
  const beats = [stateMs, logMs].filter(Number.isFinite);
  const lastHeartbeatMs = beats.length ? Math.max(...beats) : NaN;
  const alive =
    Number.isFinite(lastHeartbeatMs) && Date.now() - lastHeartbeatMs < LIVENESS_MS;
  const lastHeartbeat = Number.isFinite(lastHeartbeatMs)
    ? new Date(lastHeartbeatMs).toISOString()
    : null;

  const today = new Date().toISOString().slice(0, 10);
  const stamps = (state.deploy_rate && state.deploy_rate.timestamps) || [];
  const deploysToday = stamps.filter(
    (t) => Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === today,
  ).length;

  const dailyLossLimitSol = num(ar.dailyLossLimitSol);
  const todayLossSol = computeTodayRunLossSol(runId, baseDir);
  const dailyLossHeadroomSol =
    dailyLossLimitSol == null
      ? null
      : Math.round((dailyLossLimitSol - todayLossSol) * 1e6) / 1e6;

  return {
    configured: true,
    alive,
    lastUpdated,
    lastHeartbeat,
    runId,
    enabled: ar.enabled === true,
    promptNotes: ar.promptNotes || null,
    caps: {
      maxWalletSol: num(ar.maxWalletSol),
      dailyLossLimitSol,
      capitalBudgetPct: num(ar.capitalBudgetPct),
      maxPositions: num(uc.maxPositions),
      deployAmountSol: num(uc.deployAmountSol),
    },
    todayLossSol: Math.round(todayLossSol * 1e6) / 1e6,
    dailyLossHeadroomSol,
    deploysToday,
    openCount: open.length,
    positions: open,
    recentEvents: Array.isArray(state.recentEvents)
      ? state.recentEvents.slice(-15).reverse()
      : [],
    runNote: runCfg.note || null,
    scoringCriteria: Array.isArray(runCfg.scoringCriteria)
      ? runCfg.scoringCriteria
      : [],
    results: readArResults(runId, baseDir),
    promotions: buildPromotions(baseDir, arDir),
  };
}
