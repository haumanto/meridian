// Autoresearch run-result ledger: one JSONL line per closed position,
// under research/runs/<runId>/results.jsonl at the repo root (run
// configs/results are a human-reviewed artifact kept with the repo, not
// in the isolated data dir). Only the autoresearch profile uses this.
//
// baseDir is injectable purely for unit tests; production callers omit
// it and get paths.root. Testable without importing the executor graph.
import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { paths } from "./paths.js";

export function arResultsPath(runId, baseDir = paths.root) {
  return path.join(baseDir, "research", "runs", String(runId), "results.jsonl");
}

export function appendArResult(entry, baseDir = paths.root) {
  try {
    const file = arResultsPath(entry.runId, baseDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch (e) {
    log("executor_warn", `[autoresearch] failed to append run result: ${e.message}`);
  }
}

// Sum of TODAY's (UTC) realized SOL losses for a run, as a positive
// magnitude. Missing/unreadable ledger → 0 (the maxWalletSol cap is the
// hard backstop; this is the softer daily circuit-breaker).
export function computeTodayRunLossSol(runId, baseDir = paths.root) {
  try {
    const file = arResultsPath(runId, baseDir);
    if (!fs.existsSync(file)) return 0;
    const today = new Date().toISOString().slice(0, 10);
    let loss = 0;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (typeof rec.ts === "string" && rec.ts.slice(0, 10) === today
          && Number.isFinite(rec.pnl_sol) && rec.pnl_sol < 0) {
        loss += -rec.pnl_sol;
      }
    }
    return loss;
  } catch (e) {
    log("executor_warn", `[autoresearch] failed to compute today's run loss: ${e.message}`);
    return 0;
  }
}

// Read + summarize the whole results ledger for a run (dashboard view).
// Per-line try/catch tolerates a trailing partial append (same as
// computeTodayRunLossSol). Missing/unreadable → zeroed summary.
export function readArResults(runId, baseDir = paths.root) {
  const empty = {
    count: 0, total_pnl_usd: 0, total_pnl_sol: 0,
    avg_pnl_pct: 0, win_rate_pct: 0, recent: [],
  };
  try {
    const file = arResultsPath(runId, baseDir);
    if (!fs.existsSync(file)) return empty;
    const rows = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { continue; }
    }
    if (rows.length === 0) return empty;
    const num = (v) => (Number.isFinite(v) ? v : 0);
    const totalUsd = rows.reduce((s, r) => s + num(r.pnl_usd), 0);
    const totalSol = rows.reduce((s, r) => s + num(r.pnl_sol), 0);
    const avgPct = rows.reduce((s, r) => s + num(r.pnl_pct), 0) / rows.length;
    const wins = rows.filter((r) => num(r.pnl_usd) > 0).length;
    return {
      count: rows.length,
      total_pnl_usd: Math.round(totalUsd * 100) / 100,
      total_pnl_sol: Math.round(totalSol * 1e6) / 1e6,
      avg_pnl_pct: Math.round(avgPct * 100) / 100,
      win_rate_pct: Math.round((wins / rows.length) * 100),
      recent: rows.slice(-30).reverse(),
    };
  } catch (e) {
    log("executor_warn", `[autoresearch] failed to read run results: ${e.message}`);
    return empty;
  }
}
