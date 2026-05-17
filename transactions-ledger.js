// On-chain transaction ledger: one JSONL line per executed action
// (deploy / close / swap / claim), under <dataDir>/transactions.jsonl.
// Uses paths.dataDir (NOT paths.root) so the main and autoresearch
// profiles each get their own isolated ledger with zero branching.
//
// Mirrors autoresearch-ledger.js: every write is fire-and-forget with an
// internal try/catch — it must NEVER throw into the executor trade path.
// formatTxEntry / reconstructFromHistory are PURE (no I/O) so the
// executor-mapping logic is unit-testable without importing the executor
// graph. baseDir is injectable purely for tests.
import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { paths } from "./paths.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const CAP_BYTES = 2 * 1024 * 1024; // ~2 MB → rotate
const KEEP_LINES = 2000;           // keep newest N on rotate

export function txLedgerPath(baseDir = paths.dataDir) {
  return path.join(baseDir, "transactions.jsonl");
}

const _n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Pure: map an executor (toolName, args, result) triple to a ledger
// entry, or null when nothing should be recorded. Never throws.
export function formatTxEntry(name, args = {}, result = {}) {
  try {
    const a = args || {};
    const r = result || {};
    const pool = r.pool || a.pool_address || a.pool || null;
    const pool_name = r.pool_name || a.pool_name || null;
    if (name === "deploy_position") {
      return {
        type: "deploy",
        tx: (Array.isArray(r.txs) ? r.txs[0] : null) || r.tx || null,
        pool, pool_name,
        position: r.position || null,
        amount_sol: _n(a.amount_y ?? a.amount_sol ?? 0) || 0,
      };
    }
    if (name === "close_position") {
      return {
        type: "close",
        tx: r.tx || (Array.isArray(r.txs) ? r.txs[0] : null) || null,
        pool, pool_name,
        position: a.position_address || r.position || null,
        pnl_usd: _n(r.pnl_usd),
        pnl_pct: _n(r.pnl_pct),
        reason: a.reason || "agent decision",
      };
    }
    if (name === "swap_token") {
      const inSol = a.input_mint === SOL_MINT || a.input_mint === "SOL";
      const outSol = a.output_mint === SOL_MINT || a.output_mint === "SOL";
      return {
        type: "swap",
        tx: r.tx || null,
        pool: null, pool_name: null, position: null,
        token_amount: _n(r.amount_out),
        amount_sol: inSol ? _n(r.amount_in) : (outSol ? _n(r.amount_out) : null),
        reason: `${a.input_mint ? String(a.input_mint).slice(0, 6) : "?"}→${a.output_mint ? String(a.output_mint).slice(0, 6) : "?"}`,
      };
    }
    if (name === "claim_fees") {
      return {
        type: "claim",
        tx: (Array.isArray(r.txs) ? r.txs[0] : null) || r.tx || null,
        pool, pool_name,
        position: a.position_address || r.position || null,
      };
    }
    return null;
  } catch {
    return null; // defensive — a mapping bug must never reach the trade path
  }
}

// Size-capped rotation. Separate export so it can be unit-tested with a
// tiny cap; appendTransaction calls it with the production defaults.
export function rotateLedger(baseDir = paths.dataDir, { capBytes = CAP_BYTES, keep = KEEP_LINES } = {}) {
  try {
    const file = txLedgerPath(baseDir);
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size <= capBytes) return;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length <= keep) return;
    fs.writeFileSync(file, lines.slice(-keep).join("\n") + "\n");
  } catch (e) {
    log("executor_warn", `[tx-ledger] rotation failed: ${e.message}`);
  }
}

export function appendTransaction(entry, baseDir = paths.dataDir) {
  try {
    const file = txLedgerPath(baseDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    rotateLedger(baseDir);
  } catch (e) {
    log("executor_warn", `[tx-ledger] append failed: ${e.message}`);
  }
}

// Read the ledger newest-first for the dashboard. Per-line try/catch
// tolerates a trailing partial append. Missing/unreadable → empty.
export function readTransactions(baseDir = paths.dataDir, { limit = 200 } = {}) {
  const empty = { count: 0, entries: [] };
  try {
    const file = txLedgerPath(baseDir);
    if (!fs.existsSync(file)) return empty;
    const rows = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { continue; }
    }
    return { count: rows.length, entries: rows.slice(-limit).reverse() };
  } catch (e) {
    log("dashboard_warn", `[tx-ledger] read failed: ${e.message}`);
    return empty;
  }
}

// Pure: best-effort historical reconstruction for the dashboard when no
// real ledger exists yet. tx:null + reconstructed:true so the UI renders
// them distinctly (no tx link). Newest-last (caller reverses).
export function reconstructFromHistory({ lessons, poolMemory } = {}) {
  const out = [];
  try {
    const perf = Array.isArray(lessons?.performance) ? lessons.performance : [];
    for (const c of perf) {
      if (!c) continue;
      out.push({
        ts: c.recorded_at || c.closed_at || null,
        type: "close",
        tx: null,
        pool: c.pool || null,
        pool_name: c.pool_name || null,
        position: c.position || null,
        pnl_usd: _n(c.pnl_usd),
        pnl_pct: _n(c.pnl_pct),
        reason: c.close_reason || "reconstructed",
        reconstructed: true,
      });
    }
    // pool-memory.json is an object keyed by pool address; each value may
    // hold a deploys[] history. Defensive over unknown shapes.
    const pm = poolMemory && typeof poolMemory === "object" ? poolMemory : {};
    for (const [poolAddr, rec] of Object.entries(pm)) {
      const deploys = Array.isArray(rec?.deploys) ? rec.deploys : (Array.isArray(rec?.history) ? rec.history : []);
      for (const d of deploys) {
        if (!d || !d.deployed_at) continue;
        out.push({
          ts: d.deployed_at,
          type: "deploy",
          tx: null,
          pool: poolAddr,
          pool_name: rec?.pool_name || null,
          position: null,
          amount_sol: _n(d.amount_sol),
          reason: "reconstructed",
          reconstructed: true,
        });
      }
    }
  } catch {
    return out; // partial is fine; never throw
  }
  return out
    .filter((e) => e.ts)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}
