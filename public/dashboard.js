// Meridian dashboard — vanilla JS, Tailwind utility classes inline.
// Polls /api/* every REFRESH_MS and re-renders.

const REFRESH_MS = 10_000;
let _perfChart = null;
let _perfMode = "daily";
let _perfMetric = "total"; // total | fees
let _feesData = null;      // bucketed fees series (parallels _perfDataCache)
let _calMonth = null;      // Date (1st of displayed month) for the realized-P&L calendar
let _activityFilter = "all";
let _activitySearch = "";
let _activityCache = [];
let _candidatesCache = [];
let _candidatesSort = { key: null, dir: "asc" };
// Derived-view state (Fabriq-class portfolio analytics, all client-side).
let _allocChart = null, _drawdownChart = null, _histChart = null, _scatterChart = null, _sparkChart = null;
let _closesCache = [], _positionsCache = null, _walletCache = null;
let _posSubtab = "active";
const ALLOC_COLORS = ["#7c8fff", "#4ade80", "#fbbf24", "#f87171", "#93c5fd", "#c4b5fd", "#fbcfe8", "#5eead4", "#fda4af"];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => root.querySelectorAll(sel);

// ─── Formatters ───────────────────────────────────────
// Currency symbol follows the agent's solMode (set from /api/status).
// Values are already in the right unit server-side — this is label-only.
let CCY = "$";
let _solMode = false;   // set from /api/status sol_mode
let _solPx = 0;         // current SOL price (from /api/wallet) for approx conversion
// Caveat shown under USD-sourced cards when solMode — historical closes
// were never priced in SOL, so SOL figures are an estimate at today's price.
function arHistCaveat() {
  return (_solMode && _solPx > 0)
    ? `<div class="mt-3 text-[10.5px] text-ink-faint leading-relaxed">≈ SOL figures converted at the current SOL price ($${_solPx.toFixed(2)}) — historical closes were not recorded in SOL, so all-time PnL is USD-sourced.</div>`
    : "";
}
const fmt = {
  usd: (n) => n == null || Number.isNaN(+n) ? "—" : `${CCY}${(+n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  sol: (n) => n == null ? "—" : `${(+n).toFixed(3)} SOL`,
  pct: (n) => n == null ? "—" : `${(+n).toFixed(2)}%`,
  pctSigned: (n) => {
    if (n == null) return "—";
    const v = +n;
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  },
  usdSigned: (n) => {
    if (n == null) return "—";
    const v = +n;
    return `${v >= 0 ? "+" : "-"}${CCY}${Math.abs(v).toFixed(2)}`;
  },
  uptime: (ms) => {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  },
  shortAddr: (a) => !a ? "—" : (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a),
  // Historical / all-time USD-sourced money (lessons.json is USD-only,
  // no per-close SOL price). In solMode show an APPROXIMATE SOL value
  // converted at the CURRENT price (clearly caveated), with the exact
  // USD in parens; else plain USD. Live positions/wallet do NOT use
  // this — they are SOL-accurate already.
  hist: (n) => {
    if (n == null || Number.isNaN(+n)) return "—";
    const v = +n;
    if (_solMode && _solPx > 0) return `≈ ◎${(v / _solPx).toFixed(4)} ($${v.toFixed(2)})`;
    return `$${v.toFixed(2)}`;
  },
  histSigned: (n) => {
    if (n == null || Number.isNaN(+n)) return "—";
    const v = +n, s = v >= 0 ? "+" : "-", a = Math.abs(v);
    if (_solMode && _solPx > 0) return `≈ ${s}◎${(a / _solPx).toFixed(4)} (${s}$${a.toFixed(2)})`;
    return `${s}$${a.toFixed(2)}`;
  },
  // Chart/tile numeric: SOL-approx when solMode, else raw USD.
  histNum: (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return (_solMode && _solPx > 0) ? v / _solPx : v;
  },
  // Compact signed hist (calendar cells / tight tiles) — ≈◎ only, no
  // inline ($Y); the per-card caveat explains the conversion.
  histShort: (n) => {
    if (n == null || Number.isNaN(+n)) return "—";
    const v = +n, s = v >= 0 ? "+" : "-", a = Math.abs(v);
    return (_solMode && _solPx > 0) ? `≈${s}◎${(a / _solPx).toFixed(3)}` : `${s}$${a.toFixed(2)}`;
  },
  // Always-USD ($) signed, ignores CCY — for sources that already carry
  // a real SOL value alongside (AR ledger) or pure USD market metrics.
  usdPlainSigned: (n) => {
    if (n == null || Number.isNaN(+n)) return "—";
    const v = +n;
    return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
  },
  usdPlain: (n) => (n == null || Number.isNaN(+n)) ? "—" : `$${(+n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  // Local timezone, fixed-width "YYYY-MM-DD HH:MM:SS" — sort-friendly and
  // fits the existing 130px column. Browser's local TZ is what the operator wants.
  date: (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },
  age: (iso) => {
    if (!iso) return "—";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "—";
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  },
};

// Calendar-day / ISO-week keys in the *browser's* local timezone, so all
// P&L statistics bucket by the operator's local day — not UTC. (The server
// only sends raw timestamps now; bucketing moved here. See server.js
// /api/performance.) localIsoWeekKey mirrors the old server isoWeekKey
// (Thursday-anchored ISO 8601 week) but with local getters.
function localDayKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function localIsoWeekKey(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (t.getDay() + 6) % 7; // 0=Mon
  t.setDate(t.getDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(t.getFullYear(), 0, 4);
  const week = 1 + Math.round(
    ((t - firstThursday) / 86400_000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7,
  );
  return `${t.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Bucket raw {t, pnl_usd} points into the daily/cumulative/weekly arrays
// the chart code expects, keyed by local day/week. Falls back to any
// server-provided arrays (older response / rollback) so charts never blank.
function bucketPerf(p) {
  if (!Array.isArray(p.points)) {
    return { daily: p.daily || [], cumulative: p.cumulative || [], weekly: p.weekly || [], monthly: p.monthly || [] };
  }
  const daily = {};
  for (const pt of p.points) {
    if (!pt || !pt.t) continue;
    const d = new Date(pt.t);
    if (Number.isNaN(d.getTime())) continue;
    const key = localDayKey(d);
    if (!daily[key]) daily[key] = { date: key, count: 0, pnl_usd: 0 };
    daily[key].count += 1;
    daily[key].pnl_usd += Number(pt.pnl_usd) || 0;
  }
  const dailyArr = Object.values(daily).sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  const cumulative = dailyArr.map((dd) => {
    running += dd.pnl_usd;
    return { date: dd.date, cum_pnl_usd: Number(running.toFixed(2)) };
  });
  const weekly = {};
  for (const pt of p.points) {
    if (!pt || !pt.t) continue;
    const d = new Date(pt.t);
    if (Number.isNaN(d.getTime())) continue;
    const wk = localIsoWeekKey(d);
    if (!weekly[wk]) weekly[wk] = { week: wk, count: 0, pnl_usd: 0 };
    weekly[wk].count += 1;
    weekly[wk].pnl_usd += Number(pt.pnl_usd) || 0;
  }
  const monthly = {};
  for (const pt of p.points) {
    if (!pt || !pt.t) continue;
    const d = new Date(pt.t);
    if (Number.isNaN(d.getTime())) continue;
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!monthly[mk]) monthly[mk] = { month: mk, count: 0, pnl_usd: 0 };
    monthly[mk].count += 1;
    monthly[mk].pnl_usd += Number(pt.pnl_usd) || 0;
  }
  return {
    daily: dailyArr,
    cumulative,
    weekly: Object.values(weekly).sort((a, b) => a.week.localeCompare(b.week)),
    monthly: Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

// Fees series from detailed closes (recorded_at + fees_earned_usd) in the
// same shape bucketPerf produces, so drawPerfChart is metric-agnostic.
function bucketFees(closes) {
  const items = (closes || [])
    .map((c) => ({ t: c.recorded_at || c.closed_at, v: Number(c.fees_earned_usd) || 0 }))
    .filter((x) => x.t);
  const day = {}, wk = {}, mo = {};
  for (const it of items) {
    const d = new Date(it.t);
    if (Number.isNaN(d.getTime())) continue;
    const dk = localDayKey(d), wkk = localIsoWeekKey(d);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    (day[dk] ||= { date: dk, count: 0, pnl_usd: 0 }), day[dk].count++, day[dk].pnl_usd += it.v;
    (wk[wkk] ||= { week: wkk, count: 0, pnl_usd: 0 }), wk[wkk].count++, wk[wkk].pnl_usd += it.v;
    (mo[mk] ||= { month: mk, count: 0, pnl_usd: 0 }), mo[mk].count++, mo[mk].pnl_usd += it.v;
  }
  const dailyArr = Object.values(day).sort((a, b) => a.date.localeCompare(b.date));
  let run = 0;
  const cumulative = dailyArr.map((dd) => { run += dd.pnl_usd; return { date: dd.date, cum_pnl_usd: Number(run.toFixed(2)) }; });
  return {
    daily: dailyArr,
    weekly: Object.values(wk).sort((a, b) => a.week.localeCompare(b.week)),
    monthly: Object.values(mo).sort((a, b) => a.month.localeCompare(b.month)),
    cumulative,
  };
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ─── Tab switching ────────────────────────────────────
function setActiveTab(name) {
  $$(".tab").forEach((t) => t.setAttribute("data-active", t.dataset.tab === name ? "true" : "false"));
  $$(".tab-panel").forEach((p) => {
    if (p.id === `tab-${name}`) p.classList.remove("hidden");
    else p.classList.add("hidden");
  });
  const sel = $("#tab-select");
  if (sel && sel.value !== name) sel.value = name; // keep mobile selector in sync
}
$$(".tab").forEach((t) => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));
{
  const _tabSel = $("#tab-select");
  if (_tabSel) _tabSel.addEventListener("change", (e) => setActiveTab(e.target.value));
}

// ─── Mock banner ──────────────────────────────────────
function setMockMode(on) { $("#mock-banner").classList.toggle("hidden", !on); }

// ─── Fetch wrapper ────────────────────────────────────
async function fetchJson(url, opts) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, status: res.status, error: body.error || res.statusText, body };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Status ───────────────────────────────────────────
function renderStatus(s) {
  if (!s) return;
  CCY = s.sol_mode ? "◎" : "$";
  _solMode = !!s.sol_mode;
  const mode = $("#mode-pill");
  if (s.mode === "DRY_RUN") {
    mode.textContent = "Dry run";
    mode.className = "inline-flex items-center text-[10.5px] font-medium px-2 py-0.5 rounded-md uppercase tracking-wide text-ok bg-ok-soft border border-ok-border";
  } else {
    mode.textContent = "Live";
    mode.className = "inline-flex items-center text-[10.5px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-wide text-bad bg-bad-soft border border-bad-border";
  }
  $("#ctl-mode").textContent = s.mode === "DRY_RUN" ? "Dry run" : "Live";

  $("#emergency-pill").classList.toggle("hidden", !s.emergency_stop);

  const rate = s.deploy_rate || { lastHour: 0, lastDay: 0 };
  $("#ctl-rate").textContent = `${rate.lastHour} / ${rate.lastDay}`;

  if (s.models) {
    $("#ctl-models").textContent = `${s.models.screening} · ${s.models.management} · ${s.models.general}`;
  }
  if (s.uptime_ms != null) $("#ctl-uptime").textContent = fmt.uptime(s.uptime_ms);
  if (s.schedule) {
    $("#ctl-schedule").textContent = `${s.schedule.management_interval_min}m · ${s.schedule.screening_interval_min}m`;
  }
}

// ─── Wallet ───────────────────────────────────────────
function renderWallet(w) {
  if (!w) return;
  _walletCache = w;
  _solPx = Number(w.sol_price) || 0;
  $("#ov-wallet-sol").textContent = fmt.sol(w.sol);
  // Native SOL balance is the headline; the USD value is exact/current —
  // label it honestly as USD ($) regardless of solMode.
  const wv = Number(w.total_usd ?? w.sol_usd);
  $("#ov-wallet-usd").textContent = Number.isFinite(wv) ? `$${wv.toFixed(2)}` : "—";
}

// ─── Positions ────────────────────────────────────────
function renderPositions(p) {
  _positionsCache = p;
  const list = $("#positions-list");
  list.innerHTML = "";
  const positions = p?.positions || [];
  $("#positions-empty").classList.toggle("hidden", positions.length > 0);
  $("#ov-positions-count").textContent = positions.length;
  $("#tab-count-positions").textContent = positions.length ? positions.length : "";
  const pca = $("#pos-count-active");
  if (pca) pca.textContent = positions.length ? positions.length : "";

  let totalValue = 0, totalUnclaimed = 0, totalClaimed = 0;
  for (const pos of positions) {
    // Live positions are SOL-accurate under solMode (these *_usd fields
    // hold SOL then) — display as-is with the ◎/$ CCY. No caveat.
    totalValue += Number(pos.total_value_usd) || 0;
    totalUnclaimed += Number(pos.unclaimed_fees_usd) || 0;
    totalClaimed += Number(pos.collected_fees_usd) || 0;
    list.appendChild(buildPositionCard(pos));
  }

  $("#ov-positions-value").textContent = fmt.usd(totalValue);
  $("#ov-unclaimed-fees").textContent = fmt.usd(totalUnclaimed);
  $("#ov-claimed-fees").textContent = `claimed ${fmt.usd(totalClaimed)}`;
  $("#positions-summary").textContent =
    `${positions.length} open · ${fmt.usd(totalValue)} value · ${fmt.usd(totalClaimed + totalUnclaimed)} fees`;
}

function buildPositionCard(pos) {
  const card = document.createElement("div");
  const oor = !pos.in_range;
  card.className = `rounded-lg bg-surface-100 border ${oor ? "border-warn-border" : "border-surface-200"} hover:border-surface-300 transition-colors px-5 py-4`;

  const pnlPct = Number(pos.pnl_pct) || 0;
  const pnlClass = pnlPct >= 0 ? "text-ok" : "text-bad";
  const feesUsd = (Number(pos.collected_fees_usd) || 0) + (Number(pos.unclaimed_fees_usd) || 0);
  const ilProxy = (Number(pos.pnl_usd) || 0) - feesUsd;
  const ilClass = ilProxy >= 0 ? "text-ok" : "text-bad";

  const rangeSize = (pos.upper_bin - pos.lower_bin) || 1;
  const activeFrac = Math.max(0, Math.min(1, (pos.active_bin - pos.lower_bin) / rangeSize));

  const rec = recommendationFor(pos);
  const recStyles = {
    ok:   "border-l-ok",
    warn: "border-l-warn",
    bad:  "border-l-bad",
  };

  const statusBadge = oor
    ? `<span class="inline-flex items-center text-[10.5px] font-medium px-1.5 py-0.5 rounded text-warn bg-warn-soft border border-warn-border">OOR ${pos.minutes_out_of_range ?? 0}m</span>`
    : `<span class="inline-flex items-center text-[10.5px] font-medium px-1.5 py-0.5 rounded text-ok bg-ok-soft border border-ok-border">In range</span>`;

  card.innerHTML = `
    <div class="flex items-start justify-between gap-4 mb-3.5">
      <div class="min-w-0">
        <div class="flex items-baseline gap-2.5 flex-wrap">
          <span class="text-[16px] font-semibold tracking-tight truncate">${escapeHtml(pos.pair || "?")}</span>
          ${statusBadge}
        </div>
        <div class="mt-0.5 font-mono text-[11px] text-ink-faint truncate">${fmt.shortAddr(pos.position)}</div>
      </div>
      <div class="text-right whitespace-nowrap">
        <div class="${pnlClass} text-[16px] font-semibold tracking-tight">${fmt.pctSigned(pos.pnl_pct)}</div>
        <div class="${pnlClass} text-[11.5px] opacity-80">${fmt.usdSigned(pos.pnl_usd)}</div>
      </div>
    </div>

    <div class="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-2 text-[12px] mb-3.5">
      <div><div class="text-ink-muted text-[10.5px] uppercase tracking-[0.06em]">Value</div><div class="font-medium mt-0.5">${fmt.usd(pos.total_value_usd)}</div></div>
      <div><div class="text-ink-muted text-[10.5px] uppercase tracking-[0.06em]">Fees</div><div class="font-medium mt-0.5">${fmt.usd(feesUsd)}</div></div>
      <div><div class="text-ink-muted text-[10.5px] uppercase tracking-[0.06em]">IL proxy</div><div class="${ilClass} font-medium mt-0.5">${fmt.usdSigned(ilProxy)}</div></div>
      <div><div class="text-ink-muted text-[10.5px] uppercase tracking-[0.06em]">Age</div><div class="font-medium mt-0.5">${pos.age_minutes != null ? pos.age_minutes + "m" : "—"}</div></div>
    </div>

    <div>
      <div class="h-1.5 bg-surface-200 rounded-full relative overflow-hidden">
        <div class="${oor ? "bg-warn" : "bg-accent"} h-full rounded-full transition-all" style="width: ${(activeFrac * 100).toFixed(1)}%"></div>
      </div>
      <div class="mt-1 flex justify-between text-[10.5px] font-mono text-ink-faint">
        <span>${pos.lower_bin}</span>
        <span>active ${pos.active_bin}</span>
        <span>${pos.upper_bin}</span>
      </div>
    </div>

    <div class="mt-3 pl-3 border-l-2 ${recStyles[rec.severity]} text-[12px]">
      <span class="text-ink-muted text-[10.5px] uppercase tracking-[0.06em] mr-2">${escapeHtml(rec.label)}</span>
      <span class="text-ink-soft">${escapeHtml(rec.text)}</span>
    </div>
  `;
  return card;
}

function recommendationFor(pos) {
  const pnlPct = Number(pos.pnl_pct) || 0;
  const oorMin = Number(pos.minutes_out_of_range) || 0;
  const inRange = !!pos.in_range;
  if (!inRange && oorMin >= 20) {
    return { severity: "warn", label: "OOR", text: `Out of range ${oorMin}m — management will close on next pass.` };
  }
  if (!inRange) {
    return { severity: "warn", label: "OOR", text: `Out of range ${oorMin}m — may return; auto-close at ~20m.` };
  }
  if (pnlPct >= 5) {
    return { severity: "ok", label: "Trailing", text: `Above trailing trigger. Protected by trailing TP.` };
  }
  if (pnlPct <= -10) {
    return { severity: "bad", label: "At risk", text: `Approaching stop-loss. Watch closely.` };
  }
  return { severity: "ok", label: "OK", text: `In range, healthy PnL. Let the agent manage.` };
}

// ─── Performance ──────────────────────────────────────
let _perfDataCache = null;
function renderPerformance(p) {
  if (!p) return;
  // Bucket daily/weekly/cumulative locally (browser TZ) before charting.
  _perfDataCache = { ...p, ...bucketPerf(p) };
  _closesCache = p.closes || [];
  _feesData = bucketFees(p.closes || []);
  const s = p.summary || {};
  const pnlEl = $("#ov-total-pnl");
  pnlEl.textContent = fmt.histSigned(s.total_pnl_usd);
  pnlEl.classList.toggle("text-ok", s.total_pnl_usd >= 0);
  pnlEl.classList.toggle("text-bad", s.total_pnl_usd < 0);
  $("#ov-win-rate").textContent = `${fmt.pct(s.win_rate_pct)} win rate · ${s.total_closes} closes`;

  setRolling("#rolling-7d", "#rolling-7d-count", s.pnl_7d_usd, s.closes_7d, "closes");
  setRolling("#rolling-30d", "#rolling-30d-count", s.pnl_30d_usd, s.closes_30d, "closes");
  const avgEl = $("#rolling-avg");
  avgEl.textContent = fmt.pctSigned(s.avg_pnl_pct);
  avgEl.classList.toggle("text-ok", (s.avg_pnl_pct || 0) >= 0);
  avgEl.classList.toggle("text-bad", (s.avg_pnl_pct || 0) < 0);

  drawPerfChart();
}

function setRolling(valSel, subSel, pnl, count, suffix) {
  const el = $(valSel);
  el.textContent = fmt.histSigned(pnl);
  el.classList.toggle("text-ok", (pnl || 0) >= 0);
  el.classList.toggle("text-bad", (pnl || 0) < 0);
  $(subSel).textContent = `${count || 0} ${suffix}`;
}

function drawPerfChart() {
  const canvas = $("#perf-chart");
  if (!canvas || typeof Chart === "undefined" || !_perfDataCache) return;
  const ctx = canvas.getContext("2d");
  let labels = [], values = [], chartType = "bar", colors = [];

  const src = _perfMetric === "fees" ? _feesData : _perfDataCache;
  if (!src) return;
  const ccy = (_solMode && _solPx > 0) ? "≈◎" : "$";
  const unit = _perfMetric === "fees" ? `Fees (${ccy})` : `PnL (${ccy})`;

  if (_perfMode === "weekly") {
    const slice = (src.weekly || []).slice(-12);
    labels = slice.map((d) => d.week);
    values = slice.map((d) => fmt.histNum(d.pnl_usd));
    colors = values.map((v) => v >= 0 ? "#4ade80" : "#f87171");
  } else if (_perfMode === "monthly") {
    const slice = (src.monthly || []).slice(-12);
    labels = slice.map((d) => d.month);
    values = slice.map((d) => fmt.histNum(d.pnl_usd));
    colors = values.map((v) => v >= 0 ? "#4ade80" : "#f87171");
  } else if (_perfMode === "cumulative") {
    const slice = (src.cumulative || []).slice(-90);
    labels = slice.map((d) => d.date.slice(5));
    values = slice.map((d) => fmt.histNum(d.cum_pnl_usd));
    chartType = "line";
  } else {
    const slice = (src.daily || []).slice(-30);
    labels = slice.map((d) => d.date.slice(5));
    values = slice.map((d) => fmt.histNum(d.pnl_usd));
    colors = values.map((v) => v >= 0 ? "#4ade80" : "#f87171");
  }

  if (_perfChart) { _perfChart.destroy(); _perfChart = null; }

  const dataset = chartType === "line"
    ? {
        label: `Cumulative ${unit}`, data: values,
        borderColor: "#7c8fff", backgroundColor: "rgba(124,143,255,0.12)",
        borderWidth: 1.6, fill: true, tension: 0.3,
        pointRadius: 0, pointHoverRadius: 3,
      }
    : { label: unit, data: values, backgroundColor: colors, borderWidth: 0, borderRadius: 3, barThickness: "flex", maxBarThickness: 16 };

  _perfChart = new Chart(ctx, {
    type: chartType,
    data: { labels, datasets: [dataset] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: "index", intersect: false,
          backgroundColor: "#101113", borderColor: "#23262b", borderWidth: 1,
          titleColor: "#eceef0", bodyColor: "#a4a8b1", titleFont: { size: 11, weight: 600 },
          bodyFont: { size: 11 }, padding: 8, displayColors: false,
        },
      },
      scales: {
        x: { ticks: { color: "#71757e", font: { size: 10, family: "Inter" } }, grid: { display: false }, border: { display: false } },
        y: { ticks: { color: "#71757e", font: { size: 10, family: "Inter" } }, grid: { color: "#15171a" }, border: { display: false } },
      },
    },
  });
}

$$("#perf-mode .seg-btn").forEach((b) => {
  b.addEventListener("click", () => {
    $$("#perf-mode .seg-btn").forEach((x) => x.setAttribute("data-active", "false"));
    b.setAttribute("data-active", "true");
    _perfMode = b.dataset.mode;
    drawPerfChart();
  });
});
$$("#perf-metric .met-btn").forEach((b) => {
  b.addEventListener("click", () => {
    $$("#perf-metric .met-btn").forEach((x) => x.setAttribute("data-active", "false"));
    b.setAttribute("data-active", "true");
    _perfMetric = b.dataset.metric;
    drawPerfChart();
  });
});

// ─── Candidates ───────────────────────────────────────
function renderCandidates(c) {
  _candidatesCache = (c?.candidates || []).map((p) => ({
    ...p,
    apr_est: (Number(p.fee_tvl_ratio) || 0) * 365 * 100,
  }));
  $("#screening-meta").textContent = c?.stale
    ? "No fresh candidates"
    : `${_candidatesCache.length} candidates · latest screen`;
  drawCandidatesTable();
}

function drawCandidatesTable() {
  const tbody = $("#candidates-table tbody");
  tbody.innerHTML = "";
  const stale = $("#candidates-stale");
  const table = $("#candidates-table");

  let rows = _candidatesCache.slice();
  if (_candidatesSort.key) {
    const k = _candidatesSort.key;
    rows.sort((a, b) => {
      const av = a[k], bv = b[k];
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv));
      return _candidatesSort.dir === "asc" ? cmp : -cmp;
    });
  }

  if (rows.length === 0) {
    stale.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  stale.classList.add("hidden");
  table.classList.remove("hidden");

  for (const p of rows) {
    const tr = document.createElement("tr");
    tr.className = "border-t border-surface-200 hover:bg-surface-50 transition-colors";
    const flagBadge = (cls, text) => `<span class="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded ${cls} mr-1">${text}</span>`;
    const flags = [];
    if (p.bundle_pct != null && p.bundle_pct > 35) flags.push(flagBadge("text-warn bg-warn-soft border border-warn-border", "bundle"));
    if (p.bot_holders_pct != null && p.bot_holders_pct > 35) flags.push(flagBadge("text-warn bg-warn-soft border border-warn-border", "bots"));
    if (p.top10_pct != null && p.top10_pct > 70) flags.push(flagBadge("text-bad bg-bad-soft border border-bad-border", "top10"));
    if (p.smart_wallets_present) flags.push(flagBadge("text-ok bg-ok-soft border border-ok-border", "smart$"));
    if (p.launchpad) flags.push(flagBadge("text-ink-muted bg-surface-200 border border-surface-300", escapeHtml(p.launchpad)));
    tr.innerHTML = `
      <td class="px-4 py-2.5" data-label="Pool">
        <div class="font-medium text-ink">${escapeHtml(p.pair || p.name || "?")}</div>
        <div class="text-[10.5px] font-mono text-ink-faint">${fmt.shortAddr(p.pool_address || p.address)}</div>
      </td>
      <td class="px-4 py-2.5 text-right" data-label="TVL">${fmt.hist(p.tvl)}</td>
      <td class="px-4 py-2.5 text-right" data-label="Volume">${fmt.hist(p.volume_24h || p.volume)}</td>
      <td class="px-4 py-2.5 text-right" data-label="Vol">${p.volatility != null ? Number(p.volatility).toFixed(2) : "—"}</td>
      <td class="px-4 py-2.5 text-right" data-label="Bin">${p.bin_step || "—"}</td>
      <td class="px-4 py-2.5 text-right" data-label="Organic">${p.organic_score != null ? Math.round(p.organic_score) : "—"}</td>
      <td class="px-4 py-2.5 text-right" data-label="Fee/TVL">${p.fee_tvl_ratio != null ? Number(p.fee_tvl_ratio).toFixed(3) : "—"}</td>
      <td class="px-4 py-2.5 text-right" data-label="APR">${p.apr_est ? p.apr_est.toFixed(0) + "%" : "—"}</td>
      <td class="px-4 py-2.5" data-label="Flags">${flags.join("") || `<span class="text-ink-faint">—</span>`}</td>
    `;
    tbody.appendChild(tr);
  }
}

$$("#candidates-table thead th").forEach((th) => {
  if (!th.dataset.sort) return;
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (_candidatesSort.key === key) _candidatesSort.dir = _candidatesSort.dir === "asc" ? "desc" : "asc";
    else _candidatesSort = { key, dir: "desc" };
    $$("#candidates-table thead th").forEach((x) => x.classList.remove("sorted-asc", "sorted-desc"));
    th.classList.add(_candidatesSort.dir === "asc" ? "sorted-asc" : "sorted-desc");
    drawCandidatesTable();
  });
});

// ─── Activity ─────────────────────────────────────────
function renderActivity(a) {
  _activityCache = a?.entries || [];
  $("#tab-count-activity").textContent = _activityCache.length || "";
  $("#activity-summary").textContent = `${_activityCache.length} recent events`;
  drawActivityList();
}

const TYPE_STYLES = {
  deploy:    "text-accent bg-accent-glow border border-accent/30",
  close:     "text-ok bg-ok-soft border border-ok-border",
  claim:     "text-[#93c5fd] bg-[rgba(96,165,250,0.10)] border border-[rgba(96,165,250,0.22)]",
  skip:      "text-ink-muted bg-surface-200 border border-surface-300",
  no_deploy: "text-[#c4b5fd] bg-[rgba(180,160,200,0.08)] border border-[rgba(180,160,200,0.18)]",
  error:     "text-bad bg-bad-soft border border-bad-border",
  redeploy:  "text-[#fbcfe8] bg-[rgba(244,114,182,0.10)] border border-[rgba(244,114,182,0.22)]",
};

function drawActivityList() {
  const list = $("#activity-list");
  list.innerHTML = "";
  const q = _activitySearch.toLowerCase();
  // Defensive client-side sort: newest first by parsed timestamp.
  // Don't mutate _activityCache so re-renders (filter/search) see the original.
  const tsOf = (item) => Date.parse(item.at || item.timestamp || item.ts || item.recorded_at) || 0;
  const sorted = _activityCache.slice().sort((a, b) => tsOf(b) - tsOf(a));
  const filtered = sorted.filter((item) => {
    const type = String(item.type || "").toLowerCase();
    if (_activityFilter !== "all") {
      if (_activityFilter === "error" && !/error|fail/i.test(JSON.stringify(item))) return false;
      else if (_activityFilter !== "error" && type !== _activityFilter) return false;
    }
    if (q) {
      const blob = `${item.summary || ""} ${item.reason || ""} ${item.pool_name || ""} ${item.actor || ""} ${item.message || ""}`;
      if (!blob.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="rounded-lg border border-dashed border-surface-300 bg-surface-50 px-6 py-10 text-center text-[13px] text-ink-muted">No matching activity.</div>';
    return;
  }

  for (const item of filtered.slice(0, 200)) {
    const row = document.createElement("div");
    const type = String(item.type || "log").toLowerCase();
    const tyle = TYPE_STYLES[type] || TYPE_STYLES.skip;
    row.className = "grid grid-cols-[130px_90px_1fr] gap-3 items-center px-3.5 py-2 rounded-md border border-surface-200 bg-surface-100 hover:border-surface-300 hover:bg-surface-150 transition-colors text-[12.5px]";
    const ts = item.at || item.timestamp || item.ts || item.recorded_at;
    const body = item.summary || item.reason || item.message
      || (item.actor && item.pool_name ? `${item.actor}: ${item.pool_name}` : null)
      || JSON.stringify(item).slice(0, 240);
    row.innerHTML = `
      <span class="font-mono text-[10.5px] text-ink-faint">${escapeHtml(fmt.date(ts))}</span>
      <span class="inline-flex items-center justify-center text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${tyle}">${escapeHtml(type)}</span>
      <span class="text-ink-soft break-words">${escapeHtml(body)}</span>
    `;
    list.appendChild(row);
  }
}

$$("#activity-filters .chip").forEach((c) => {
  c.addEventListener("click", () => {
    $$("#activity-filters .chip").forEach((x) => x.setAttribute("data-active", "false"));
    c.setAttribute("data-active", "true");
    _activityFilter = c.dataset.filter;
    drawActivityList();
  });
});
$("#activity-search").addEventListener("input", (e) => {
  _activitySearch = e.target.value.trim();
  drawActivityList();
});

// ─── Blacklist ────────────────────────────────────────
function renderBlacklist(b) {
  const items = b?.blacklist || [];
  $("#tab-count-blacklist").textContent = items.length || "";
  $("#blacklist-summary").textContent = `${items.length} blacklisted`;
  const empty = $("#blacklist-empty");
  const table = $("#blacklist-table");
  const tbody = $("#blacklist-table tbody");
  tbody.innerHTML = "";
  if (items.length === 0) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");
  for (const item of items) {
    const tr = document.createElement("tr");
    tr.className = "border-t border-surface-200 hover:bg-surface-50 transition-colors";
    tr.innerHTML = `
      <td class="px-4 py-2.5 font-medium" data-label="Symbol">${escapeHtml(item.symbol || "—")}</td>
      <td class="px-4 py-2.5 font-mono text-[11.5px] text-ink-soft" data-label="Mint">${fmt.shortAddr(item.mint)}</td>
      <td class="px-4 py-2.5 text-ink-soft" data-label="Reason">${escapeHtml(item.reason || "—")}</td>
      <td class="px-4 py-2.5 text-ink-muted" data-label="Added">${escapeHtml(item.added_at ? fmt.age(item.added_at) : "—")}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ─── Config / Settings ────────────────────────────────
function renderConfig(c) {
  if (!c) return;
  renderKV($("#settings-models"), c.llm);
  renderKV($("#settings-risk"), c.risk);
  renderKV($("#settings-mgmt"), c.management);
  renderKV($("#settings-screening"), c.screening);
  renderSettingsHealth(c);
}

const PILL_STYLES = {
  ok:   "text-ok bg-ok-soft border border-ok-border",
  bad:  "text-bad bg-bad-soft border border-bad-border",
  warn: "text-warn bg-warn-soft border border-warn-border",
  off:  "text-ink-muted bg-surface-200 border border-surface-300",
  live: "text-bad bg-bad-soft border border-bad-border font-semibold",
  dry:  "text-ok bg-ok-soft border border-ok-border",
};
function pillHtml(style, text) {
  return `<span class="inline-flex items-center text-[10.5px] font-medium px-2 py-0.5 rounded uppercase tracking-wide ${PILL_STYLES[style] || PILL_STYLES.off}">${escapeHtml(text)}</span>`;
}

function renderSettingsHealth(c) {
  const el = $("#settings-health");
  if (!el) return;
  el.innerHTML = "";
  const integ = c.integrations || {};
  const rpcHost = integ.rpc_endpoint_host || "—";
  const llmHost = integ.llm_endpoint_host || "—";
  const rows = [
    { label: "Mode",            html: pillHtml(c.mode === "DRY_RUN" ? "dry" : "live", c.mode === "DRY_RUN" ? "Dry run" : "Live") },
    { label: "Emergency stop",  html: pillHtml(c.risk?.emergencyStop ? "bad" : "ok", c.risk?.emergencyStop ? "Active" : "Off") },
    { label: "RPC endpoint",    html: pillHtml(rpcHost === "—" ? "off" : "ok", rpcHost) },
    { label: "LLM endpoint",    html: pillHtml(llmHost === "—" ? "off" : "ok", llmHost) },
    { label: "Telegram",        html: pillHtml(integ.telegram ? "ok" : "off", integ.telegram ? "Enabled" : "Disabled") },
    { label: "Helius",          html: pillHtml(integ.helius ? "ok" : "off", integ.helius ? "Enabled" : "Disabled") },
    { label: "HiveMind",        html: pillHtml(integ.hivemind ? "ok" : "off", integ.hivemind ? "Enabled" : "Disabled") },
  ];
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between";
    row.innerHTML = `<dt class="text-ink-muted">${escapeHtml(r.label)}</dt><dd>${r.html}</dd>`;
    el.appendChild(row);
  }
}

function renderKV(el, obj) {
  if (!el) return;
  el.innerHTML = "";
  for (const [k, v] of Object.entries(obj || {})) {
    const row = document.createElement("div");
    row.className = "flex items-baseline justify-between gap-3";
    let displayV;
    if (typeof v === "boolean") displayV = v ? "✓" : "✗";
    else if (v == null) displayV = "—";
    else if (Array.isArray(v)) displayV = v.length === 0 ? "—" : v.join(", ");
    else if (typeof v === "object") displayV = JSON.stringify(v);
    else displayV = String(v);
    row.innerHTML = `<dt class="text-ink-muted">${escapeHtml(k)}</dt><dd class="font-mono text-[11.5px] text-ink-soft text-right break-all">${escapeHtml(displayV)}</dd>`;
    el.appendChild(row);
  }
}

// ─── Emergency stop actions ───────────────────────────
async function authPost(url, action) {
  const password = prompt(`DASHBOARD_PASSWORD to ${action}:`);
  if (!password) return null;
  const auth = "Basic " + btoa(`admin:${password}`);
  return fetchJson(url, { method: "POST", headers: { Authorization: auth } });
}
$("#btn-emergency-stop").addEventListener("click", async () => {
  const res = await authPost("/api/emergency-stop", "activate emergency stop");
  if (!res) return;
  if (res.ok) { alert("Emergency stop activated."); refresh(); }
  else alert(`Failed: ${res.error || res.status}`);
});
$("#btn-resume").addEventListener("click", async () => {
  const res = await authPost("/api/resume", "clear emergency stop");
  if (!res) return;
  if (res.ok) { alert("Emergency stop cleared."); refresh(); }
  else alert(`Failed: ${res.error || res.status}`);
});
$("#refresh-btn").addEventListener("click", () => refresh());

// ─── Main refresh loop ───────────────────────────────
function renderAutoresearch(status, positions, results) {
  const summary = $("#ar-summary");
  const absent = $("#ar-absent");
  const body = $("#ar-body");
  const tabCount = $("#tab-count-autoresearch");

  if (!status || status.configured === false) {
    absent.classList.remove("hidden");
    body.classList.add("hidden");
    summary.textContent = "not running";
    if (tabCount) tabCount.textContent = "";
    return;
  }
  absent.classList.add("hidden");
  body.classList.remove("hidden");

  const sol4 = (n) => (n == null ? "—" : `${(+n).toFixed(4)} SOL`);
  const row = (label, val, cls = "") =>
    `<div class="flex justify-between items-baseline"><dt class="text-ink-muted">${label}</dt><dd class="font-medium ${cls}">${val}</dd></div>`;

  const aliveBadge = status.alive
    ? `<span class="text-ok">● live</span>`
    : `<span class="text-ink-muted">○ idle</span>`;
  summary.innerHTML = `${aliveBadge} · heartbeat ${fmt.age(status.lastHeartbeat || status.lastUpdated)}`;
  if (tabCount) tabCount.textContent = status.openCount ? status.openCount : "";

  $("#ar-run").innerHTML = [
    row("Run ID", escapeHtml(status.runId || "—")),
    row("Status", status.alive ? `<span class="text-ok">live</span>` : `<span class="text-ink-muted">idle</span>`),
    row("Heartbeat", `${escapeHtml(fmt.date(status.lastHeartbeat || status.lastUpdated))} <span class="text-ink-faint">(${fmt.age(status.lastHeartbeat || status.lastUpdated)})</span>`),
    row("State written", `<span class="text-ink-faint">${fmt.age(status.lastUpdated)}</span>`),
    row("Enabled", status.enabled ? "yes" : "no"),
    row("Open positions", status.openCount ?? 0),
    status.runNote ? row("Note", `<span class="text-ink-soft">${escapeHtml(status.runNote)}</span>`) : "",
    status.promptNotes ? row("Prompt notes", `<span class="text-ink-soft">${escapeHtml(status.promptNotes)}</span>`) : "",
    status.scoringCriteria?.length ? row("Optimizes for", `<span class="text-ink-soft">${escapeHtml(status.scoringCriteria.join(", "))}</span>`) : "",
  ].join("");

  const c = status.caps || {};
  const headroom = status.dailyLossHeadroomSol;
  const headClass = headroom == null ? "" : (headroom <= 0 ? "text-bad" : "text-ok");
  $("#ar-caps").innerHTML = [
    row("Max wallet", sol4(c.maxWalletSol)),
    row("Daily loss limit", sol4(c.dailyLossLimitSol)),
    row("Today's loss", sol4(status.todayLossSol)),
    row("Loss headroom", sol4(headroom), headClass),
    row("Deploys today", status.deploysToday ?? 0),
    row("Deploy size", sol4(c.deployAmountSol)),
    row("Max positions", c.maxPositions ?? "—"),
    row("Capital budget", c.capitalBudgetPct == null ? "—" : `${(c.capitalBudgetPct * 100).toFixed(1)}%`),
  ].join("");

  const posList = $("#ar-positions-list");
  const posEmpty = $("#ar-positions-empty");
  const pos = (positions && positions.positions) || [];
  if (pos.length === 0) {
    posEmpty.classList.remove("hidden");
    posList.innerHTML = "";
  } else {
    posEmpty.classList.add("hidden");
    posList.innerHTML = pos.map((p) => {
      const oor = p.out_of_range_since ? `<span class="text-warn">OOR ${fmt.age(p.out_of_range_since)}</span>` : `<span class="text-ok">in range</span>`;
      return `<div class="rounded-md border border-surface-200 bg-surface-50 px-4 py-3 text-[12.5px]">
        <div class="flex items-baseline justify-between">
          <div class="font-medium">${escapeHtml(p.pool_name || "—")} <span class="text-ink-faint font-mono text-[11px]">${fmt.shortAddr(p.pool)}</span></div>
          <div>${oor}</div>
        </div>
        <div class="grid grid-cols-4 gap-3 mt-2 text-ink-muted text-[11px]">
          <div><div class="uppercase tracking-[0.06em]">Size</div><div class="font-medium text-ink mt-0.5">${sol4(p.amount_sol)}</div></div>
          <div><div class="uppercase tracking-[0.06em]">Strategy</div><div class="font-medium text-ink mt-0.5">${escapeHtml(p.strategy || "—")}</div></div>
          <div><div class="uppercase tracking-[0.06em]">Peak PnL</div><div class="font-medium text-ink mt-0.5">${p.peak_pnl_pct == null ? "—" : fmt.pctSigned(p.peak_pnl_pct)}</div></div>
          <div><div class="uppercase tracking-[0.06em]">Age</div><div class="font-medium text-ink mt-0.5">${fmt.age(p.deployed_at)}</div></div>
        </div>
        <div class="grid grid-cols-4 gap-3 mt-2 text-ink-muted text-[11px]">
          <div><div class="uppercase tracking-[0.06em]">Volatility</div><div class="font-medium text-ink mt-0.5">${p.volatility == null ? "—" : Number(p.volatility).toFixed(2)}</div></div>
          <div><div class="uppercase tracking-[0.06em]">Organic</div><div class="font-medium text-ink mt-0.5">${p.organic_score == null ? "—" : Math.round(p.organic_score)}</div></div>
          <div><div class="uppercase tracking-[0.06em]">Init $</div><div class="font-medium text-ink mt-0.5">${p.initial_value_usd == null ? "—" : fmt.hist(p.initial_value_usd)}</div></div>
          <div><div class="uppercase tracking-[0.06em]">Bin range</div><div class="font-medium text-ink mt-0.5">${p.bin_range && p.bin_range.min != null ? `${p.bin_range.min}→${p.bin_range.max}` : "—"}</div></div>
        </div>
      </div>`;
    }).join("");
  }

  const r = results || {};
  $("#ar-results-summary").textContent = r.count
    ? `${r.count} closes · ${fmt.pct(r.win_rate_pct)} win · ◎${(r.total_pnl_sol ?? 0).toFixed(4)} (${fmt.usdPlainSigned(r.total_pnl_usd)})`
    : "—";
  const kpis = $("#ar-results-kpis");
  if (kpis) {
    if (!r.count) {
      kpis.classList.add("hidden");
      kpis.innerHTML = "";
    } else {
      kpis.classList.remove("hidden");
      const tile = (label, val, cls = "") =>
        `<div class="rounded-md border border-surface-200 px-3 py-2.5"><div class="text-[10px] uppercase tracking-[0.08em] text-ink-muted font-medium">${label}</div><div class="mt-1 text-[15px] font-semibold tracking-tight ${cls}">${val}</div></div>`;
      kpis.innerHTML =
        tile("Closes", r.count) +
        tile("Win rate", fmt.pct(r.win_rate_pct)) +
        tile("Total PnL", `◎${(r.total_pnl_sol ?? 0).toFixed(4)}`, (r.total_pnl_usd ?? 0) >= 0 ? "text-ok" : "text-bad") +
        tile("Avg PnL %", fmt.pctSigned(r.avg_pnl_pct), (r.avg_pnl_pct ?? 0) >= 0 ? "text-ok" : "text-bad");
    }
  }
  const resList = $("#ar-results-list");
  const resEmpty = $("#ar-results-empty");
  const recent = r.recent || [];
  if (recent.length === 0) {
    resEmpty.classList.remove("hidden");
    resList.innerHTML = "";
  } else {
    resEmpty.classList.add("hidden");
    resList.innerHTML = recent.map((x) => {
      const cls = (x.pnl_usd ?? 0) >= 0 ? "text-ok" : "text-bad";
      return `<div class="flex items-baseline justify-between border-b border-surface-200 pb-1.5 text-[12px]">
        <div><span class="font-medium">${escapeHtml(x.pool_name || x.pool || "—")}</span> <span class="text-ink-faint">${escapeHtml(x.reason || "")}</span></div>
        <div class="text-right"><span class="${cls} font-medium">${x.pnl_sol == null ? fmt.usdPlainSigned(x.pnl_usd) : `◎${Number(x.pnl_sol).toFixed(4)}`} ${x.pnl_pct == null ? "" : `(${fmt.pctSigned(x.pnl_pct)})`}</span><div class="text-ink-faint text-[10.5px]">${escapeHtml(fmt.date(x.ts))}</div></div>
      </div>`;
    }).join("");
  }

  // Activity feed — from positions.recentEvents (already returned by
  // /api/ar/positions; was never rendered).
  const evList = $("#ar-events-list");
  const evEmpty = $("#ar-events-empty");
  if (evList) {
    const events = (positions && positions.recentEvents) || [];
    if (events.length === 0) {
      if (evEmpty) evEmpty.classList.remove("hidden");
      evList.innerHTML = "";
    } else {
      if (evEmpty) evEmpty.classList.add("hidden");
      evList.innerHTML = events.map((e) => {
        const act = String(e.action || e.type || "event").toLowerCase();
        const ac = act.includes("deploy") ? "text-ok" : (act.includes("close") ? "text-warn" : "text-ink-muted");
        const ts = e.ts || e.at || e.timestamp;
        return `<div class="flex items-baseline justify-between border-b border-surface-200 pb-1.5 text-[12px]">
          <div><span class="${ac} font-medium uppercase text-[10.5px] tracking-[0.06em]">${escapeHtml(act)}</span> <span class="text-ink-soft">${escapeHtml(e.pool_name || e.pool || "—")}</span> <span class="text-ink-faint">${escapeHtml(e.reason || e.summary || "")}</span></div>
          <div class="text-ink-faint text-[10.5px] text-right whitespace-nowrap">${escapeHtml(fmt.age(ts))}</div>
        </div>`;
      }).join("");
    }
  }
}

// Read-only mirror of the promotion-advisor lifecycle (pending→requested
// →applied). Approval stays in Telegram by isolation design — the
// dashboard only observes. Never trips mock-mode (sibling of AR).
function renderArPromotions(p) {
  const summary = $("#ar-promo-summary");
  const empty = $("#ar-promo-empty");
  const bodyEl = $("#ar-promo-body");
  if (!summary) return;
  const pending = (p && Array.isArray(p.pending)) ? p.pending : [];
  const requested = (p && Array.isArray(p.requested)) ? p.requested : [];
  const applied = (p && Array.isArray(p.applied)) ? p.applied : [];
  const failed = (p && Number(p.failedCount)) || 0;
  const total = pending.length + requested.length + applied.length;

  if (!p || p.configured === false || total === 0) {
    if (empty) empty.classList.remove("hidden");
    if (bodyEl) bodyEl.classList.add("hidden");
    summary.textContent = (p && p.configured === false) ? "not running" : "no candidates";
    return;
  }
  if (empty) empty.classList.add("hidden");
  if (bodyEl) bodyEl.classList.remove("hidden");
  summary.textContent =
    `${pending.length} pending · ${requested.length} requested · ${applied.length} applied${failed ? ` · ${failed} failed` : ""}`;

  const toggle = (id, n) => { const e = $(id); if (e) e.classList.toggle("hidden", n > 0); };
  toggle("#ar-promo-pending-empty", pending.length);
  toggle("#ar-promo-requested-empty", requested.length);
  toggle("#ar-promo-applied-empty", applied.length);

  const stats = (f) =>
    `${f.n ?? "?"} closes · ${f.pools ?? "?"} pools · ${fmt.pct(f.winRate)} win · ${f.totalPnlSol == null ? fmt.usdPlainSigned(f.totalPnlUsd) : `◎${Number(f.totalPnlSol).toFixed(4)} (${fmt.usdPlainSigned(f.totalPnlUsd)})`}`;

  $("#ar-promo-pending").innerHTML = pending.map((f) => `
    <div class="rounded-md border border-warn-border bg-warn-soft/40 px-4 py-3 text-[12px]">
      <div class="flex items-baseline justify-between gap-3">
        <span class="font-medium text-ink">${escapeHtml(f.patternKey || f.sig || "—")}</span>
        <span class="text-ink-faint text-[10.5px] whitespace-nowrap">awaiting ${escapeHtml(fmt.age(f.alertedAt))}</span>
      </div>
      <div class="mt-1 text-ink-soft">${escapeHtml(stats(f))}</div>
      ${Array.isArray(f.reasons) && f.reasons.length ? `<ul class="mt-1.5 space-y-0.5 text-[11px] text-ink-muted">${f.reasons.map((r) => `<li>• ${escapeHtml(String(r))}</li>`).join("")}</ul>` : ""}
      ${f.suggestedRule ? `<div class="mt-2 rounded bg-surface-200 px-2.5 py-1.5 font-mono text-[11px] text-ink-soft break-words">${escapeHtml(f.suggestedRule)}</div>` : ""}
    </div>`).join("");

  $("#ar-promo-requested").innerHTML = requested.map((f) => `
    <div class="flex items-baseline justify-between border-b border-surface-200 pb-1.5 text-[12px]">
      <span class="text-ink-soft truncate">${escapeHtml(f.patternKey || f.sig || "—")} <span class="text-ink-faint">${escapeHtml(stats(f))}</span></span>
      <span class="text-ink-faint text-[10.5px] whitespace-nowrap ml-3">requested ${escapeHtml(fmt.age(f.requestedAt))}</span>
    </div>`).join("");

  $("#ar-promo-applied").innerHTML = applied.map((a) => `
    <div class="flex items-baseline justify-between border-b border-surface-200 pb-1.5 text-[12px]">
      <span class="text-ink-soft truncate">${escapeHtml(a.strategy || "—")}${a.binStep != null ? ` · bin ${escapeHtml(String(a.binStep))}` : ""} <span class="text-ink-faint">${escapeHtml(a.suggestedRule || "")}</span></span>
      <span class="text-ink-faint text-[10.5px] whitespace-nowrap ml-3">${a.appliedAt ? `${escapeHtml(fmt.date(a.appliedAt))} (${escapeHtml(fmt.age(a.appliedAt))})` : "—"}</span>
    </div>`).join("");
}

// ─── Derived portfolio analytics (Fabriq-class, all client-side) ──────
// One Chart.js instance per canvas, module-scoped. Update-in-place
// (cheaper than destroy/recreate) when the instance exists, else create.
function upsertChart(inst, canvasSel, cfg) {
  const canvas = $(canvasSel);
  if (!canvas || typeof Chart === "undefined") return inst;
  if (inst) {
    inst.data = cfg.data;
    if (cfg.options) inst.options = cfg.options;
    inst.update("none");
    return inst;
  }
  return new Chart(canvas.getContext("2d"), cfg);
}

// Shared chart styling (mirrors drawPerfChart's tokens — kept inline,
// matching house style; no dashboard.css additions).
const _tip = {
  backgroundColor: "#101113", borderColor: "#23262b", borderWidth: 1,
  titleColor: "#eceef0", bodyColor: "#a4a8b1", titleFont: { size: 11, weight: 600 },
  bodyFont: { size: 11 }, padding: 8, displayColors: false,
};
const _axis = {
  x: { ticks: { color: "#71757e", font: { size: 10, family: "Inter" } }, grid: { display: false }, border: { display: false } },
  y: { ticks: { color: "#71757e", font: { size: 10, family: "Inter" } }, grid: { color: "#15171a" }, border: { display: false } },
};
const _holdFmt = (m) => {
  m = Math.round(Number(m) || 0);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

function renderKpiExtras() {
  const splitEl = $("#ov-pnl-split"), deltaEl = $("#ov-pnl-delta"), ext = $("#perf-extremes");
  const realized = Number(_perfDataCache?.summary?.total_pnl_usd);
  const positions = _positionsCache?.positions || [];
  const unreal = positions.reduce((s, p) => s + (Number(p.pnl_usd) || 0), 0);
  if (splitEl) splitEl.textContent = `Realized ${fmt.histSigned(Number.isFinite(realized) ? realized : 0)} · Unrealized ${fmt.usdSigned(unreal)}`;

  if (deltaEl) {
    const daily = _perfDataCache?.daily || [];
    const now = Date.now(), DAY = 86400000;
    let cur = 0, prev = 0;
    for (const d of daily) {
      const t = Date.parse(`${d.date}T00:00:00`);
      if (Number.isNaN(t)) continue;
      const age = now - t;
      if (age <= 7 * DAY) cur += Number(d.pnl_usd) || 0;
      else if (age <= 14 * DAY) prev += Number(d.pnl_usd) || 0;
    }
    if (daily.length === 0) {
      deltaEl.textContent = "—";
      deltaEl.className = "text-[11px] font-medium text-ink-faint";
    } else {
      const diff = cur - prev, up = diff >= 0;
      deltaEl.textContent = `${up ? "▲" : "▼"} ${fmt.histSigned(diff)} vs prior 7d`;
      deltaEl.className = `text-[11px] font-medium ${up ? "text-ok" : "text-bad"}`;
    }
  }

  if (ext) {
    const pcts = (_closesCache || []).map((c) => Number(c.pnl_pct)).filter(Number.isFinite);
    if (pcts.length === 0) ext.innerHTML = "—" + arHistCaveat();
    else ext.innerHTML = `Best <span class="text-ok font-medium">${fmt.pctSigned(Math.max(...pcts))}</span> · Worst <span class="text-bad font-medium">${fmt.pctSigned(Math.min(...pcts))}</span> · ${pcts.length} closed` + arHistCaveat();
  }

  const sc = $("#ov-spark");
  if (sc && typeof Chart !== "undefined") {
    const cum = (_perfDataCache?.cumulative || []).slice(-30);
    if (cum.length < 2) {
      if (_sparkChart) { _sparkChart.destroy(); _sparkChart = null; }
    } else {
      _sparkChart = upsertChart(_sparkChart, "#ov-spark", {
        type: "line",
        data: { labels: cum.map(() => ""), datasets: [{ data: cum.map((d) => fmt.histNum(d.cum_pnl_usd)), borderColor: "#7c8fff", borderWidth: 1.5, fill: false, tension: 0.35, pointRadius: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } } },
      });
    }
  }
}

function renderAllocation() {
  const empty = $("#alloc-empty"), legend = $("#alloc-legend"), canvas = $("#alloc-chart");
  if (!canvas) return;
  const positions = _positionsCache?.positions || [];
  const slices = positions
    .map((p) => ({ label: p.pair || fmt.shortAddr(p.position) || "?", value: Number(p.total_value_usd) || 0 }))
    .filter((s) => s.value > 0);
  // Position slices use total_value_usd (SOL-accurate under solMode);
  // keep idle in the same unit so the doughnut proportions are valid.
  const idle = Number((_solMode && _solPx > 0) ? _walletCache?.sol : _walletCache?.sol_usd) || 0;
  if (idle > 0) slices.push({ label: "Idle SOL", value: idle, idle: true });
  if (slices.length === 0) {
    empty.classList.remove("hidden");
    canvas.classList.add("hidden");
    if (_allocChart) { _allocChart.destroy(); _allocChart = null; }
    if (legend) legend.innerHTML = "";
    return;
  }
  empty.classList.add("hidden");
  canvas.classList.remove("hidden");
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const colors = slices.map((s, i) => (s.idle ? "#4a4d56" : ALLOC_COLORS[i % ALLOC_COLORS.length]));
  _allocChart = upsertChart(_allocChart, "#alloc-chart", {
    type: "doughnut",
    data: { labels: slices.map((s) => s.label), datasets: [{ data: slices.map((s) => s.value), backgroundColor: colors, borderColor: "#101113", borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%", animation: { duration: 200 },
      plugins: {
        legend: { display: false },
        tooltip: { ..._tip, callbacks: { label: (c) => `${c.label}: ${fmt.usd(c.parsed)} (${(c.parsed / total * 100).toFixed(1)}%)` } },
      },
    },
  });
  if (legend) legend.innerHTML = slices.map((s, i) => `
    <div class="flex items-center justify-between">
      <span class="flex items-center gap-2 min-w-0"><span class="h-2 w-2 rounded-full flex-shrink-0" style="background:${colors[i]}"></span><span class="truncate text-ink-soft">${escapeHtml(s.label)}</span></span>
      <span class="text-ink-muted whitespace-nowrap ml-3">${fmt.usd(s.value)} · ${(s.value / total * 100).toFixed(1)}%</span>
    </div>`).join("");
}

function renderDrawdown() {
  const canvas = $("#drawdown-chart"), empty = $("#drawdown-empty"), meta = $("#drawdown-meta");
  if (!canvas) return;
  const cum = _perfDataCache?.cumulative || [];
  if (cum.length === 0) {
    empty.classList.remove("hidden");
    canvas.classList.add("hidden");
    if (_drawdownChart) { _drawdownChart.destroy(); _drawdownChart = null; }
    if (meta) { meta.textContent = "—"; meta.className = "text-[11.5px] text-ink-muted"; }
    return;
  }
  empty.classList.add("hidden");
  canvas.classList.remove("hidden");
  let peak = -Infinity;
  const labels = [], data = [];
  for (const d of cum) {
    const v = Number(d.cum_pnl_usd) || 0;
    peak = Math.max(peak, v);
    labels.push(d.date.slice(5));
    data.push(Number((v - peak).toFixed(2)));
  }
  const maxDD = data.length ? Math.min(...data) : 0;
  if (meta) {
    meta.textContent = `Max ${fmt.histSigned(maxDD)}`;
    meta.className = `text-[11.5px] ${maxDD < 0 ? "text-bad" : "text-ink-muted"}`;
  }
  _drawdownChart = upsertChart(_drawdownChart, "#drawdown-chart", {
    type: "line",
    data: { labels, datasets: [{ label: `Drawdown (${(_solMode && _solPx > 0) ? "≈◎" : "$"})`, data: data.map((v) => fmt.histNum(v)), borderColor: "#f87171", backgroundColor: "rgba(248,113,113,0.10)", borderWidth: 1.4, fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
      plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, ..._tip } },
      scales: _axis,
    },
  });
}

function renderPoolPerf() {
  const table = $("#poolperf-table"), empty = $("#poolperf-empty"), meta = $("#poolperf-meta");
  if (!table) return;
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  const closes = _closesCache || [];
  if (closes.length === 0) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    if (meta) meta.textContent = "—";
    return;
  }
  const g = new Map();
  for (const c of closes) {
    const key = c.pool || c.pool_name || "?";
    let r = g.get(key);
    if (!r) { r = { name: c.pool_name || fmt.shortAddr(c.pool) || "?", n: 0, wins: 0, pnlUsd: 0, pnlPct: 0, hold: 0, dep: 0, wd: 0, fees: 0 }; g.set(key, r); }
    r.n++;
    if ((Number(c.pnl_pct) || 0) > 0) r.wins++;
    r.pnlUsd += Number(c.pnl_usd) || 0;
    r.pnlPct += Number(c.pnl_pct) || 0;
    r.hold += Number(c.minutes_held) || 0;
    r.dep += Number(c.initial_value_usd) || 0;
    r.wd += Number(c.final_value_usd) || 0;
    r.fees += Number(c.fees_earned_usd) || 0;
  }
  const rows = [...g.values()].sort((a, b) => b.pnlUsd - a.pnlUsd);
  empty.classList.add("hidden");
  table.classList.remove("hidden");
  if (meta) meta.textContent = `${rows.length} pools · ${closes.length} closes`;
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.className = "border-t border-surface-200 hover:bg-surface-50 transition-colors";
    const pc = r.pnlUsd >= 0 ? "text-ok" : "text-bad";
    const ap = r.pnlPct / r.n;
    tr.innerHTML = `
      <td class="px-4 py-2.5" data-label="Pool"><div class="font-medium text-ink">${escapeHtml(r.name)}</div></td>
      <td class="px-4 py-2.5 text-right" data-label="Closes">${r.n}</td>
      <td class="px-4 py-2.5 text-right" data-label="Win%">${(r.wins / r.n * 100).toFixed(0)}%</td>
      <td class="px-4 py-2.5 text-right ${pc} font-medium" data-label="Total PnL">${fmt.histSigned(r.pnlUsd)}</td>
      <td class="px-4 py-2.5 text-right ${ap >= 0 ? "text-ok" : "text-bad"}" data-label="Avg PnL%">${fmt.pctSigned(ap)}</td>
      <td class="px-4 py-2.5 text-right text-ink-soft" data-label="Deposits">${fmt.hist(r.dep)}</td>
      <td class="px-4 py-2.5 text-right text-ink-soft" data-label="Withdrawals">${fmt.hist(r.wd)}</td>
      <td class="px-4 py-2.5 text-right text-ink-soft" data-label="Fees">${fmt.hist(r.fees)}</td>
      <td class="px-4 py-2.5 text-right text-ink-soft" data-label="Duration">${_holdFmt(r.hold)}</td>
      <td class="px-4 py-2.5 text-right text-ink-soft" data-label="Avg hold">${_holdFmt(r.hold / r.n)}</td>`;
    tbody.appendChild(tr);
  }
}

function buildHistoryCard(c) {
  const card = document.createElement("div");
  const pnlUsd = Number(c.pnl_usd) || 0;
  const sev = pnlUsd >= 0 ? "border-l-ok" : "border-l-bad";
  const pc = pnlUsd >= 0 ? "text-ok" : "text-bad";
  card.className = "rounded-lg bg-surface-100 border border-surface-200 hover:border-surface-300 transition-colors px-5 py-4";
  card.innerHTML = `
    <div class="flex items-start justify-between gap-4 mb-3.5">
      <div class="min-w-0">
        <div class="flex items-baseline gap-2.5 flex-wrap">
          <span class="text-[15px] font-semibold tracking-tight truncate">${escapeHtml(c.pool_name || "?")}</span>
          <span class="inline-flex items-center text-[10.5px] font-medium px-1.5 py-0.5 rounded text-ink-muted bg-surface-200 border border-surface-300">${escapeHtml(c.strategy || "—")}</span>
        </div>
        <div class="mt-0.5 font-mono text-[11px] text-ink-faint truncate">${fmt.shortAddr(c.position || c.pool)} · ${escapeHtml(fmt.date(c.recorded_at))}</div>
      </div>
      <div class="text-right whitespace-nowrap">
        <div class="${pc} text-[15px] font-semibold tracking-tight">${fmt.pctSigned(c.pnl_pct)}</div>
        <div class="${pc} text-[11.5px] opacity-80">${fmt.histSigned(pnlUsd)}</div>
      </div>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-2 text-[12px] mb-3.5">
      <div><div class="text-ink-muted text-[10.5px] uppercase tracking-[0.06em]">Initial</div><div class="font-medium mt-0.5">${fmt.hist(c.initial_value_usd)}</div></div>
      <div><div class="text-ink-muted text-[10.5px] uppercase tracking-[0.06em]">Final</div><div class="font-medium mt-0.5">${fmt.hist(c.final_value_usd)}</div></div>
      <div><div class="text-ink-muted text-[10.5px] uppercase tracking-[0.06em]">Fees</div><div class="font-medium mt-0.5">${fmt.hist(c.fees_earned_usd)}</div></div>
      <div><div class="text-ink-muted text-[10.5px] uppercase tracking-[0.06em]">Hold</div><div class="font-medium mt-0.5">${_holdFmt(c.minutes_held)}</div></div>
    </div>
    <div class="pl-3 border-l-2 ${sev} text-[12px]">
      <span class="text-ink-muted text-[10.5px] uppercase tracking-[0.06em] mr-2">Close</span>
      <span class="text-ink-soft">${escapeHtml(c.close_reason || "—")}</span>
    </div>`;
  return card;
}

function renderHistory() {
  const list = $("#history-list"), empty = $("#history-empty"), count = $("#pos-count-history");
  if (!list) return;
  const closes = (_closesCache || []).slice(0, 50);
  if (count) count.textContent = closes.length ? closes.length : "";
  if (closes.length === 0) {
    if (empty) empty.classList.remove("hidden");
    list.innerHTML = "";
    return;
  }
  if (empty) empty.classList.add("hidden");
  list.innerHTML = "";
  for (const c of closes) list.appendChild(buildHistoryCard(c));
}

function renderHistogram() {
  const canvas = $("#hist-chart"), empty = $("#hist-empty");
  if (!canvas) return;
  const vals = (_closesCache || []).map((c) => Number(c.pnl_pct)).filter(Number.isFinite);
  if (vals.length === 0) {
    empty.classList.remove("hidden");
    canvas.classList.add("hidden");
    if (_histChart) { _histChart.destroy(); _histChart = null; }
    return;
  }
  empty.classList.add("hidden");
  canvas.classList.remove("hidden");
  const edges = [-20, -10, -5, -2, 0, 2, 5, 10, 20];
  const labels = ["≤-20", "-20…-10", "-10…-5", "-5…-2", "-2…0", "0…2", "2…5", "5…10", "10…20", ">20"];
  const counts = new Array(10).fill(0);
  for (const v of vals) {
    let idx = edges.findIndex((e) => v < e);
    if (idx === -1) idx = 9;
    counts[idx]++;
  }
  const colors = labels.map((_, i) => (i <= 4 ? "#f87171" : "#4ade80"));
  _histChart = upsertChart(_histChart, "#hist-chart", {
    type: "bar",
    data: { labels, datasets: [{ label: "Trades", data: counts, backgroundColor: colors, borderWidth: 0, borderRadius: 3, barThickness: "flex", maxBarThickness: 38 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
      plugins: { legend: { display: false }, tooltip: { ..._tip, callbacks: { title: (it) => `PnL ${it[0].label}%`, label: (c) => `${c.parsed.y} trades` } } },
      scales: { x: _axis.x, y: { ..._axis.y, ticks: { ..._axis.y.ticks, precision: 0 } } },
    },
  });
}

function renderScatter() {
  const canvas = $("#scatter-chart"), empty = $("#scatter-empty");
  if (!canvas) return;
  const pts = (_candidatesCache || [])
    .map((p) => ({
      x: Number(p.volatility), y: Number(p.apr_est),
      pair: p.pair || p.name || "?",
      risky: (Number(p.bundle_pct) || 0) > 35 || (Number(p.top10_pct) || 0) > 70,
    }))
    .filter((d) => Number.isFinite(d.x) && Number.isFinite(d.y));
  if (pts.length === 0) {
    empty.classList.remove("hidden");
    canvas.classList.add("hidden");
    if (_scatterChart) { _scatterChart.destroy(); _scatterChart = null; }
    return;
  }
  empty.classList.add("hidden");
  canvas.classList.remove("hidden");
  _scatterChart = upsertChart(_scatterChart, "#scatter-chart", {
    type: "scatter",
    data: { datasets: [{ data: pts, pointBackgroundColor: pts.map((p) => (p.risky ? "#f87171" : "#7c8fff")), pointBorderColor: pts.map((p) => (p.risky ? "#f87171" : "#7c8fff")), pointRadius: 4, pointHoverRadius: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
      plugins: { legend: { display: false }, tooltip: { ..._tip, callbacks: { label: (c) => `${pts[c.dataIndex].pair}: vol ${c.parsed.x.toFixed(2)} · APR ${c.parsed.y.toFixed(0)}%` } } },
      scales: {
        x: { title: { display: true, text: "Volatility", color: "#71757e", font: { size: 10 } }, ticks: { color: "#71757e", font: { size: 10, family: "Inter" } }, grid: { color: "#15171a" }, border: { display: false } },
        y: { title: { display: true, text: "Est. APR %", color: "#71757e", font: { size: 10 } }, ticks: { color: "#71757e", font: { size: 10, family: "Inter" } }, grid: { color: "#15171a" }, border: { display: false } },
      },
    },
  });
}

// Single aggregator: runs once per refresh after all base renders have
// populated the caches; each sub-render is independently guarded so one
// failure can't break the loop, the AR tab, or mock-mode.
// ── Fabriq-style performance metrics / calendar / summary ───────────
// Win-loss stats from the full points[] (server caps at 500 closes);
// deposit/withdraw/fee aggregates from the detailed closes[] (last 50).
function _perfStats() {
  const pts = _perfDataCache?.points || [];
  const pnls = pts.map((p) => Number(p.pnl_usd) || 0);
  const wins = pnls.filter((v) => v > 0);
  const losses = pnls.filter((v) => v < 0);
  const grossWin = wins.reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
  const net = Number(_perfDataCache?.summary?.total_pnl_usd ?? (grossWin - grossLoss));
  const total = pnls.length;
  const daily = _perfDataCache?.daily || [];
  const dayWins = daily.filter((d) => (Number(d.pnl_usd) || 0) > 0).length;
  return {
    total, net, wins: wins.length, losses: losses.length,
    winPct: total ? (wins.length / total) * 100 : 0,
    grossWin, grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    days: daily.length, dayWins,
    dayWinPct: daily.length ? (dayWins / daily.length) * 100 : 0,
  };
}

// Two-segment ring gauge (green share / red remainder) — no Chart.js,
// so zero per-refresh chart churn.
function gaugeSVG(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<svg width="46" height="46" viewBox="0 0 36 36" class="block">
    <circle cx="18" cy="18" r="15.5" fill="none" stroke="#f87171" stroke-width="3.4" pathLength="100"/>
    <circle cx="18" cy="18" r="15.5" fill="none" stroke="#4ade80" stroke-width="3.4" pathLength="100"
      stroke-dasharray="${p.toFixed(1)} ${(100 - p).toFixed(1)}" stroke-linecap="round" transform="rotate(-90 18 18)"/>
  </svg>`;
}

function renderHeroMetrics() {
  if (!_perfDataCache) return;
  const s = _perfStats();
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  const setHTML = (id, v) => { const e = $(id); if (e) e.innerHTML = v; };

  const np = $("#hm-netpnl");
  if (np) { np.textContent = fmt.histSigned(s.net); np.classList.toggle("text-ok", s.net >= 0); np.classList.toggle("text-bad", s.net < 0); }
  set("#hm-netpnl-sub", `${s.total} closes`);

  set("#hm-winpct", `${s.winPct.toFixed(1)}%`);
  set("#hm-winpct-sub", `${s.wins}W · ${s.losses}L`);
  setHTML("#hm-winpct-gauge", gaugeSVG(s.winPct));

  const pfStr = s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2);
  set("#hm-pf", pfStr);
  set("#hm-pf-sub", `${fmt.hist(s.grossWin)} / ${fmt.hist(s.grossLoss)}`);
  setHTML("#hm-pf-gauge", gaugeSVG(Math.min(100, (s.profitFactor === Infinity ? 3 : s.profitFactor) / 3 * 100)));

  set("#hm-daywin", `${s.dayWinPct.toFixed(1)}%`);
  set("#hm-daywin-sub", `${s.dayWins}/${s.days} days`);
  setHTML("#hm-daywin-gauge", gaugeSVG(s.dayWinPct));

  const ratio = s.avgLoss > 0 ? s.avgWin / s.avgLoss : (s.avgWin > 0 ? Infinity : 0);
  set("#hm-wl", ratio === Infinity ? "∞" : ratio.toFixed(2));
  const wlSum = s.avgWin + s.avgLoss;
  const winW = wlSum > 0 ? (s.avgWin / wlSum) * 100 : 50;
  const ww = $("#hm-wl-win"), wl = $("#hm-wl-loss");
  if (ww) ww.style.width = `${winW.toFixed(1)}%`;
  if (wl) wl.style.width = `${(100 - winW).toFixed(1)}%`;
  const sub = $("#hm-wl-sub");
  if (sub) sub.innerHTML = `<span class="text-ok">${fmt.hist(s.avgWin)}</span><span class="text-bad">-${fmt.hist(s.avgLoss)}</span>`;
}

function renderPerfSummary() {
  const dl = $("#perf-summary");
  if (!dl || !_perfDataCache) return;
  const s = _perfStats();
  const closes = _closesCache || [];
  const dep = closes.reduce((a, c) => a + (Number(c.initial_value_usd) || 0), 0);
  const wd = closes.reduce((a, c) => a + (Number(c.final_value_usd) || 0), 0);
  const fees = closes.reduce((a, c) => a + (Number(c.fees_earned_usd) || 0), 0);
  const row = (k, v) => `<div class="flex items-baseline justify-between"><dt class="text-ink-muted">${k}</dt><dd class="font-medium">${v}</dd></div>`;
  dl.innerHTML = [
    row("Wins / Losses", `<span class="text-ok">${s.wins}W</span> · <span class="text-bad">${s.losses}L</span> · ${s.total}`),
    row("Win rate", `${s.winPct.toFixed(1)}%`),
    row("Deposits", fmt.hist(dep)),
    row("Withdrawals", fmt.hist(wd)),
    row("Fees earned", fmt.hist(fees)),
    row("Gross win / loss", `<span class="text-ok">${fmt.hist(s.grossWin)}</span> / <span class="text-bad">${fmt.hist(s.grossLoss)}</span>`),
  ].join("") + arHistCaveat();
  const tp = $("#perf-total-profit-val");
  if (tp) { tp.textContent = fmt.histSigned(s.net); tp.classList.toggle("text-ok", s.net >= 0); tp.classList.toggle("text-bad", s.net < 0); }
}

// Per-local-day {sum,count,wins} from points[] for the calendar heatmap.
function _dayMap() {
  const m = new Map();
  for (const pt of (_perfDataCache?.points || [])) {
    if (!pt || !pt.t) continue;
    const d = new Date(pt.t);
    if (Number.isNaN(d.getTime())) continue;
    const k = localDayKey(d);
    const v = Number(pt.pnl_usd) || 0;
    let r = m.get(k);
    if (!r) { r = { sum: 0, count: 0, wins: 0 }; m.set(k, r); }
    r.sum += v; r.count += 1; if (v > 0) r.wins += 1;
  }
  return m;
}

function renderCalendar() {
  const grid = $("#cal-grid"), weeks = $("#cal-weeks"), label = $("#cal-month");
  const empty = $("#cal-empty"), wrap = $("#cal-wrap");
  if (!grid) return;
  const dm = _dayMap();
  if (dm.size === 0) {
    if (empty) empty.classList.remove("hidden");
    if (wrap) wrap.classList.add("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");
  if (wrap) wrap.classList.remove("hidden");
  if (!_calMonth) {
    const keys = [...dm.keys()].sort();
    const [yy, mm] = keys[keys.length - 1].split("-").map(Number);
    _calMonth = new Date(yy, mm - 1, 1);
  }
  const y = _calMonth.getFullYear(), mo = _calMonth.getMonth();
  if (label) label.textContent = _calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const daysIn = new Date(y, mo + 1, 0).getDate();
  const lead = new Date(y, mo, 1).getDay();
  let cells = "";
  for (let i = 0; i < lead; i++) cells += "<div></div>";
  const weekAgg = {};
  for (let day = 1; day <= daysIn; day++) {
    const key = `${y}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const r = dm.get(key);
    if (r) {
      const wkk = localIsoWeekKey(new Date(y, mo, day));
      (weekAgg[wkk] ||= { sum: 0, days: 0 });
      weekAgg[wkk].sum += r.sum; weekAgg[wkk].days += 1;
    }
    if (!r) {
      cells += `<div class="rounded border border-surface-200 bg-surface-50 px-1.5 py-1 min-h-[52px]"><div class="text-[10px] text-ink-faint text-right">${day}</div></div>`;
    } else {
      const pos = r.sum >= 0;
      const a = Math.min(1, Math.abs(r.sum) / 200);
      const bg = pos ? `rgba(74,222,128,${(0.07 + a * 0.22).toFixed(3)})` : `rgba(248,113,113,${(0.07 + a * 0.22).toFixed(3)})`;
      const bd = pos ? "rgba(74,222,128,0.22)" : "rgba(248,113,113,0.25)";
      cells += `<div class="rounded border px-1.5 py-1 min-h-[52px]" style="background:${bg};border-color:${bd}">
        <div class="text-[10px] text-ink-faint text-right">${day}</div>
        <div class="text-[11px] font-semibold ${pos ? "text-ok" : "text-bad"} leading-tight">${fmt.histShort(r.sum)}</div>
        <div class="text-[9.5px] text-ink-muted">${r.count}p · ${Math.round(r.wins / r.count * 100)}%</div>
      </div>`;
    }
  }
  grid.innerHTML = cells;
  if (weeks) {
    const wkKeys = Object.keys(weekAgg).sort();
    weeks.innerHTML = `<div class="text-[10px] uppercase tracking-[0.06em] text-ink-muted mb-1">Weeks</div>` +
      (wkKeys.length === 0
        ? `<div class="text-[11px] text-ink-faint">—</div>`
        : wkKeys.map((k, i) => {
            const w = weekAgg[k]; const pos = w.sum >= 0;
            return `<div class="rounded border border-surface-200 bg-surface-50 px-2 py-1.5">
              <div class="text-[10px] text-ink-muted">W${i + 1}</div>
              <div class="text-[11px] font-semibold ${pos ? "text-ok" : "text-bad"}">${fmt.histShort(w.sum)}</div>
              <div class="text-[9.5px] text-ink-faint">${w.days}d</div>
            </div>`;
          }).join(""));
  }
}

const _calPrev = $("#cal-prev");
if (_calPrev) _calPrev.addEventListener("click", () => {
  if (!_calMonth) return;
  _calMonth = new Date(_calMonth.getFullYear(), _calMonth.getMonth() - 1, 1);
  renderCalendar();
});
const _calNext = $("#cal-next");
if (_calNext) _calNext.addEventListener("click", () => {
  if (!_calMonth) return;
  _calMonth = new Date(_calMonth.getFullYear(), _calMonth.getMonth() + 1, 1);
  renderCalendar();
});

// ── Transactions ledger tab (from /api/transactions) ───────────────
const _TX_STYLE = {
  deploy: "text-accent bg-accent-glow border border-accent/30",
  close: "text-ok bg-ok-soft border border-ok-border",
  claim: "text-[#93c5fd] bg-[rgba(96,165,250,0.10)] border border-[rgba(96,165,250,0.22)]",
  swap: "text-[#c4b5fd] bg-[rgba(180,160,200,0.08)] border border-[rgba(180,160,200,0.18)]",
};
function renderTransactions(d) {
  const list = $("#transactions-list"), empty = $("#transactions-empty");
  const summ = $("#transactions-summary"), note = $("#transactions-note"), count = $("#tab-count-transactions");
  if (!list) return;
  const rows = (d && Array.isArray(d.entries)) ? d.entries : [];
  if (count) count.textContent = rows.length ? rows.length : "";
  if (note) note.classList.toggle("hidden", !d?.reconstructed);
  if (summ) summ.textContent = rows.length
    ? `${d.count} ${d.reconstructed ? "reconstructed" : "recorded"}${d.stale ? " · stale" : ""}`
    : "—";
  if (rows.length === 0) {
    if (empty) empty.classList.remove("hidden");
    list.innerHTML = "";
    return;
  }
  if (empty) empty.classList.add("hidden");
  list.innerHTML = rows.slice(0, 200).map((e) => {
    const ty = String(e.type || "log").toLowerCase();
    const sty = _TX_STYLE[ty] || _TX_STYLE.swap;
    const bits = [];
    if (e.amount_sol != null) bits.push(`${fmt.sol(e.amount_sol)}`);
    if (e.token_amount != null) bits.push(`${Number(e.token_amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} tok`);
    if (e.pnl_usd != null) bits.push(`<span class="${e.pnl_usd >= 0 ? "text-ok" : "text-bad"}">${fmt.usdSigned(e.pnl_usd)}${e.pnl_pct != null ? ` (${fmt.pctSigned(e.pnl_pct)})` : ""}</span>`);
    const txCell = e.tx
      ? `<a href="https://solscan.io/tx/${encodeURIComponent(e.tx)}" target="_blank" rel="noopener" class="font-mono text-[10.5px] text-accent hover:underline">${fmt.shortAddr(e.tx)}</a>`
      : `<span class="font-mono text-[10.5px] text-ink-faint">${e.reconstructed ? "reconstructed" : "—"}</span>`;
    return `<div class="grid grid-cols-[150px_84px_1fr_auto] gap-3 items-center px-3.5 py-2 rounded-md border border-surface-200 bg-surface-100 hover:border-surface-300 hover:bg-surface-150 transition-colors text-[12.5px]">
      <span class="font-mono text-[10.5px] text-ink-faint">${escapeHtml(fmt.date(e.ts))}</span>
      <span class="inline-flex items-center justify-center text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${sty}">${escapeHtml(ty)}</span>
      <span class="text-ink-soft truncate">${escapeHtml(e.pool_name || e.pool || e.reason || "—")}${bits.length ? ` · ${bits.join(" · ")}` : ""}</span>
      ${txCell}
    </div>`;
  }).join("");
}

// ── Balances tab (client-side from the existing /api/wallet cache) ──
function renderBalances() {
  const table = $("#balances-table"), empty = $("#balances-empty"), summ = $("#balances-summary"), count = $("#tab-count-balances");
  if (!table) return;
  const tbody = table.querySelector("tbody");
  const w = _walletCache;
  const rows = [];
  if (w && (Number(w.sol) > 0 || Number(w.sol_usd) > 0)) {
    rows.push({ sym: "SOL", mint: "So11111111111111111111111111111111111111112", amt: Number(w.sol) || 0, usd: Number(w.sol_usd) || 0 });
  }
  for (const t of (w?.tokens || [])) {
    rows.push({ sym: t.symbol || (t.mint ? t.mint.slice(0, 6) : "?"), mint: t.mint, amt: Number(t.balance) || 0, usd: Number(t.usd) || 0 });
  }
  if (rows.length === 0) {
    if (empty) empty.classList.remove("hidden");
    table.classList.add("hidden");
    tbody.innerHTML = "";
    if (summ) summ.textContent = "—";
    if (count) count.textContent = "";
    return;
  }
  if (empty) empty.classList.add("hidden");
  table.classList.remove("hidden");
  const verified = rows.filter((r) => r.usd >= 1).sort((a, b) => b.usd - a.usd);
  const dust = rows.filter((r) => r.usd < 1);
  const grand = rows.reduce((s, r) => s + r.usd, 0);
  const dustVal = dust.reduce((s, r) => s + r.usd, 0);
  if (summ) summ.textContent = `${rows.length} tokens · ${fmt.hist(grand)}`;
  if (count) count.textContent = rows.length ? rows.length : "";
  const fmtAmt = (n) => {
    n = Number(n) || 0;
    if (n === 0) return "0";
    return n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : Number(n.toPrecision(4)).toString();
  };
  const section = (label, val) => `<tr class="bg-surface-50 border-t border-surface-200"><td class="px-4 py-2 text-[11px] uppercase tracking-[0.06em] text-ink-muted font-medium">${escapeHtml(label)}</td><td></td><td class="px-4 py-2 text-right font-semibold">${val}</td></tr>`;
  let html = section("Grand total", fmt.hist(grand));
  html += section(`Verified · ${verified.length}`, fmt.hist(grand - dustVal));
  for (const r of verified) {
    html += `<tr class="border-t border-surface-200 hover:bg-surface-50 transition-colors">
      <td class="px-4 py-2.5" data-label="Token"><span class="font-medium text-ink">${escapeHtml(r.sym)}</span> <span class="font-mono text-[10.5px] text-ink-faint">${fmt.shortAddr(r.mint)}</span></td>
      <td class="px-4 py-2.5 text-right text-ink-soft" data-label="Amount">${fmtAmt(r.amt)}</td>
      <td class="px-4 py-2.5 text-right font-medium" data-label="Value">${fmt.hist(r.usd)}</td>
    </tr>`;
  }
  if (dust.length) html += section(`Dust · ${dust.length} tokens < $1`, fmt.hist(dustVal));
  tbody.innerHTML = html;
}

function renderDerived() {
  for (const fn of [renderKpiExtras, renderHeroMetrics, renderPerfSummary, renderCalendar, renderAllocation, renderDrawdown, renderPoolPerf, renderHistory, renderHistogram, renderScatter, renderBalances]) {
    try { fn(); } catch (e) { console.warn(`[dashboard] ${fn.name} failed:`, e); }
  }
}

$$("#pos-subtabs .pos-seg").forEach((b) => {
  b.addEventListener("click", () => {
    $$("#pos-subtabs .pos-seg").forEach((x) => x.setAttribute("data-active", "false"));
    b.setAttribute("data-active", "true");
    _posSubtab = b.dataset.pos;
    $("#pos-panel-active").classList.toggle("hidden", _posSubtab !== "active");
    $("#pos-panel-history").classList.toggle("hidden", _posSubtab !== "history");
  });
});

async function refresh() {
  const start = Date.now();
  const [status, wallet, positions, performance, candidates, activity, configRes, blacklist, transactions, arStatus, arPositions, arResults, arPromotions] = await Promise.all([
    fetchJson("/api/status"),
    fetchJson("/api/wallet"),
    fetchJson("/api/positions"),
    fetchJson("/api/performance"),
    fetchJson("/api/candidates"),
    fetchJson("/api/activity"),
    fetchJson("/api/config"),
    fetchJson("/api/blacklist"),
    fetchJson("/api/transactions"),
    fetchJson("/api/ar/status"),
    fetchJson("/api/ar/positions"),
    fetchJson("/api/ar/results"),
    fetchJson("/api/ar/promotions"),
  ]);

  let anyMock = false;
  if (status.ok) renderStatus(status.data); else anyMock = true;
  if (wallet.ok) renderWallet(wallet.data); else anyMock = true;
  if (positions.ok) renderPositions(positions.data); else anyMock = true;
  if (performance.ok) renderPerformance(performance.data); else anyMock = true;
  if (candidates.ok) renderCandidates(candidates.data); else anyMock = true;
  if (activity.ok) renderActivity(activity.data); else anyMock = true;
  if (configRes.ok) renderConfig(configRes.data); else anyMock = true;
  if (blacklist.ok) renderBlacklist(blacklist.data); else anyMock = true;
  // Transactions: supplementary + may be reconstructed/empty pre-ledger
  // — never trips mock mode (mirrors AR).
  if (transactions.ok) renderTransactions(transactions.data);
  // AR is read-only and may legitimately be absent — never trips mock mode.
  renderAutoresearch(
    arStatus.ok ? arStatus.data : null,
    arPositions.ok ? arPositions.data : null,
    arResults.ok ? arResults.data : null,
  );
  renderArPromotions(arPromotions.ok ? arPromotions.data : null);

  // Derived analytics — after the base renders have populated the caches,
  // before mock-mode. Never trips anyMock; fully self-guarded.
  renderDerived();

  setMockMode(anyMock);
  $("#updated-at").textContent = `${new Date().toLocaleTimeString()} · ${Date.now() - start}ms`;
}

refresh();
setInterval(refresh, REFRESH_MS);
