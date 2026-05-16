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
