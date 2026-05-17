// Autoresearch → main "promotion advisor".
//
// The isolated AR instance evaluates its OWN closed-trade record and,
// when a *generalizable* pattern clears the promotion bar, alerts the
// operator via AR's dedicated Telegram bot with the evidence + an
// Approve button. Approval drops one JSON request into
// <root>/promotion-requests/ which the MAIN agent consumes on its next
// management cycle and applies via addLesson(). AR never writes main's
// lessons.json — the isolation wall holds; this queue dir is the only
// crossing: one-way, file-based, and human-gated by the Approve tap.
//
// evaluatePromotions() is PURE (data in → findings out) so it is unit-
// testable with no I/O. The exported I/O wrappers do the file work.

import fs from "fs";
import path from "path";
import { paths } from "./paths.js";
import { log } from "./logger.js";

const QUEUE_DIR = path.join(paths.root, "promotion-requests");
const APPLIED_DIR = path.join(QUEUE_DIR, "applied");
const STATE_PATH = path.join(paths.dataDir, "promotions.json");

// Defaults reflect the agreed bar (meaningful but reachable at AR's low
// volume): enough closes, across enough distinct pools (so it's a
// pattern, not one lucky token), durable win rate + median. Env-tunable.
const DEFAULTS = {
  minCloses: Number(process.env.AR_PROMOTE_MIN_CLOSES) || 12,
  minPools: Number(process.env.AR_PROMOTE_MIN_POOLS) || 3,
  minWinRatePct: Number(process.env.AR_PROMOTE_MIN_WINRATE) || 60,
};

export function volBand(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "v?";
  if (n < 2) return "vlo";
  if (n <= 4) return "vmid";
  return "vhi";
}

// A pattern must generalize beyond one pool: strategy + bin_step + a
// volatility band. (Pool identity deliberately excluded from the key —
// the multi-pool count is what proves generalization.)
export function patternKey(r) {
  const strat = String(r.strategy || "?").toLowerCase();
  const bin = r.bin_step != null ? `b${r.bin_step}` : "b?";
  return `${strat}|${bin}|${volBand(r.volatility)}`;
}

// Short, stable id (djb2 → base36) for callback_data + queue filenames.
export function sigOf(s) {
  let h = 5381;
  for (let i = 0; i < String(s).length; i++) h = (((h << 5) + h) + String(s).charCodeAt(i)) | 0;
  return "p" + (h >>> 0).toString(36);
}

function median(xs) {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const normRule = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

const VOL_LABEL = { vlo: "<2", vmid: "2-4", vhi: ">4", "v?": "n/a" };

/**
 * PURE. Group AR performance records into generalizable patterns, keep
 * only those clearing the bar and not already alerted/requested or
 * already represented in main's lessons. Returns ranked findings.
 *
 * @param perf          AR profiles/autoresearch/lessons.json performance[]
 * @param mainLessons   main lessons.json lessons[] (dedupe)
 * @param alreadyHandled Set<sig> already alerted or requested
 * @param cfg           { minCloses, minPools, minWinRatePct } overrides
 */
export function evaluatePromotions({ perf = [], mainLessons = [], alreadyHandled = new Set(), cfg = {} } = {}) {
  const C = { ...DEFAULTS, ...cfg };
  const groups = new Map();
  for (const r of perf) {
    if (r == null || r.pnl_pct == null) continue;
    const k = patternKey(r);
    let g = groups.get(k);
    if (!g) { g = { key: k, recs: [], pools: new Set() }; groups.set(k, g); }
    g.recs.push(r);
    if (r.pool) g.pools.add(r.pool);
  }
  const mainNorm = mainLessons.map((l) => normRule(l.rule));
  const out = [];
  for (const g of groups.values()) {
    const sig = sigOf(g.key);
    if (alreadyHandled.has(sig)) continue;
    const n = g.recs.length;
    const pools = g.pools.size;
    const pcts = g.recs.map((r) => Number(r.pnl_pct) || 0);
    const usd = g.recs.reduce((s, r) => s + (Number(r.pnl_usd) || 0), 0);
    const sol = g.recs.reduce((s, r) => s + (Number(r.pnl_sol) || 0), 0);
    const wins = pcts.filter((p) => p > 0).length;
    const winRate = n ? (wins / n) * 100 : 0;
    const avg = n ? pcts.reduce((a, b) => a + b, 0) / n : 0;
    const med = median(pcts);

    const reasons = [];
    if (n < C.minCloses) continue;
    reasons.push(`${n} closes (>= ${C.minCloses})`);
    if (pools < C.minPools) continue;
    reasons.push(`${pools} distinct pools (>= ${C.minPools}) — generalizes, not one token`);
    if (winRate < C.minWinRatePct) continue;
    reasons.push(`${winRate.toFixed(0)}% win rate (>= ${C.minWinRatePct}%)`);
    if (usd <= 0) continue;
    reasons.push(`aggregate PnL +$${usd.toFixed(2)}`);
    if (med <= 0) continue;
    reasons.push(`median trade +${med.toFixed(2)}% (durable, not one outlier)`);

    const [strat, bin] = g.key.split("|");
    const binStep = bin.replace(/^b/, "");
    const volLabel = VOL_LABEL[volBand(g.recs[0].volatility)] || "n/a";
    const suggestedRule =
      `PREFER: strategy="${strat}" on bin_step=${binStep}, volatility ${volLabel} pools — ` +
      `AR evidence: ${n} closes / ${pools} pools, ${winRate.toFixed(0)}% win, ` +
      `avg ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%, median ${med >= 0 ? "+" : ""}${med.toFixed(2)}%, ` +
      `net +$${usd.toFixed(2)}.`;

    // Main already carries a lesson for this strategy+bin_step → skip.
    if (mainNorm.some((m) => m.includes(`strategy="${strat}"`) && m.includes(`bin_step=${binStep}`))) continue;

    out.push({
      sig, patternKey: g.key, strategy: strat, binStep, volLabel,
      n, pools, winRate: Number(winRate.toFixed(1)), avgPnlPct: Number(avg.toFixed(2)),
      medianPnlPct: Number(med.toFixed(2)), totalPnlUsd: Number(usd.toFixed(2)),
      totalPnlSol: Number(sol.toFixed(4)), reasons, suggestedRule,
    });
  }
  out.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
  return out;
}

// ── I/O wrappers (not pure; thin) ───────────────────────────────────

export function loadPromoState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      return { alerted: s.alerted || {}, requested: s.requested || {}, pending: s.pending || {} };
    }
  } catch { /* fall through to empty */ }
  return { alerted: {}, requested: {}, pending: {} };
}

export function savePromoState(st) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
  } catch (e) {
    log("autoresearch_warn", `promotion state save failed: ${e.message}`);
  }
}

export function readArPerf() {
  try {
    const f = JSON.parse(fs.readFileSync(paths.lessonsPath, "utf8"));
    return Array.isArray(f.performance) ? f.performance : [];
  } catch { return []; }
}

// AR reads main's root lessons.json read-only, purely for dedupe.
export function readMainLessons() {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(paths.root, "lessons.json"), "utf8"));
    return Array.isArray(f.lessons) ? f.lessons : [];
  } catch { return []; }
}

export function writePromotionRequest(rec) {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const file = path.join(QUEUE_DIR, `${rec.sig}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...rec, requested_at: new Date().toISOString() }, null, 2));
  return file;
}

/**
 * MAIN-side: drain the queue. `addLesson` is injected (avoids a
 * lessons.js import cycle and keeps this module test-friendly).
 * Each request is applied once then archived under applied/.
 */
export function consumePromotionRequests(addLesson) {
  const applied = [];
  let files;
  try {
    files = fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return applied; // dir doesn't exist yet → nothing to do
  }
  if (!files.length) return applied;
  fs.mkdirSync(APPLIED_DIR, { recursive: true });
  for (const f of files) {
    const p = path.join(QUEUE_DIR, f);
    try {
      const rec = JSON.parse(fs.readFileSync(p, "utf8"));
      if (rec && typeof rec.suggestedRule === "string" && rec.suggestedRule.trim()) {
        addLesson(
          rec.suggestedRule,
          ["autoresearch", "promoted", rec.strategy].filter(Boolean),
          { role: "SCREENER" },
        );
        applied.push({ sig: rec.sig, rule: rec.suggestedRule });
        log("autoresearch", `Promoted AR finding ${rec.sig} → main lessons: ${rec.suggestedRule}`);
      }
      fs.renameSync(p, path.join(APPLIED_DIR, `${Date.now()}-${f}`));
    } catch (e) {
      log("autoresearch_warn", `promotion request ${f} skipped: ${e.message}`);
      try { fs.renameSync(p, path.join(APPLIED_DIR, `bad-${Date.now()}-${f}`)); } catch { /* ignore */ }
    }
  }
  return applied;
}
