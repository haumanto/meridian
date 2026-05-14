// Meridian dashboard — vanilla JS, Tailwind utility classes inline.
// Polls /api/* every REFRESH_MS and re-renders.

const REFRESH_MS = 10_000;
let _perfChart = null;
let _perfMode = "daily";
let _activityFilter = "all";
let _activitySearch = "";
let _activityCache = [];
let _candidatesCache = [];
let _candidatesSort = { key: null, dir: "asc" };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => root.querySelectorAll(sel);

// ─── Formatters ───────────────────────────────────────
const fmt = {
  usd: (n) => n == null || Number.isNaN(+n) ? "—" : `$${(+n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
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
    return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
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
  date: (iso) => !iso ? "—" : String(iso).slice(0, 19).replace("T", " ").replace("Z", ""),
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
}
$$(".tab").forEach((t) => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));

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
  $("#ov-wallet-sol").textContent = fmt.sol(w.sol);
  $("#ov-wallet-usd").textContent = fmt.usd(w.total_usd ?? w.sol_usd);
}

// ─── Positions ────────────────────────────────────────
function renderPositions(p) {
  const list = $("#positions-list");
  list.innerHTML = "";
  const positions = p?.positions || [];
  $("#positions-empty").classList.toggle("hidden", positions.length > 0);
  $("#ov-positions-count").textContent = positions.length;
  $("#tab-count-positions").textContent = positions.length ? positions.length : "";

  let totalValue = 0, totalUnclaimed = 0, totalClaimed = 0;
  for (const pos of positions) {
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
  _perfDataCache = p;
  const s = p.summary || {};
  const pnlEl = $("#ov-total-pnl");
  pnlEl.textContent = fmt.usdSigned(s.total_pnl_usd);
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
  el.textContent = fmt.usdSigned(pnl);
  el.classList.toggle("text-ok", (pnl || 0) >= 0);
  el.classList.toggle("text-bad", (pnl || 0) < 0);
  $(subSel).textContent = `${count || 0} ${suffix}`;
}

function drawPerfChart() {
  const canvas = $("#perf-chart");
  if (!canvas || typeof Chart === "undefined" || !_perfDataCache) return;
  const ctx = canvas.getContext("2d");
  let labels = [], values = [], chartType = "bar", colors = [];

  if (_perfMode === "daily") {
    const slice = (_perfDataCache.daily || []).slice(-30);
    labels = slice.map((d) => d.date.slice(5));
    values = slice.map((d) => Number(d.pnl_usd) || 0);
    colors = values.map((v) => v >= 0 ? "#4ade80" : "#f87171");
  } else if (_perfMode === "weekly") {
    const slice = (_perfDataCache.weekly || []).slice(-12);
    labels = slice.map((d) => d.week);
    values = slice.map((d) => Number(d.pnl_usd) || 0);
    colors = values.map((v) => v >= 0 ? "#4ade80" : "#f87171");
  } else if (_perfMode === "cumulative") {
    const slice = (_perfDataCache.cumulative || []).slice(-90);
    labels = slice.map((d) => d.date.slice(5));
    values = slice.map((d) => Number(d.cum_pnl_usd) || 0);
    chartType = "line";
  }

  if (_perfChart) { _perfChart.destroy(); _perfChart = null; }

  const dataset = chartType === "line"
    ? {
        label: "Cumulative PnL ($)", data: values,
        borderColor: "#7c8fff", backgroundColor: "rgba(124,143,255,0.12)",
        borderWidth: 1.6, fill: true, tension: 0.3,
        pointRadius: 0, pointHoverRadius: 3,
      }
    : { label: "PnL ($)", data: values, backgroundColor: colors, borderWidth: 0, borderRadius: 3, barThickness: "flex", maxBarThickness: 16 };

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
      <td class="px-4 py-2.5">
        <div class="font-medium text-ink">${escapeHtml(p.pair || p.name || "?")}</div>
        <div class="text-[10.5px] font-mono text-ink-faint">${fmt.shortAddr(p.pool_address || p.address)}</div>
      </td>
      <td class="px-4 py-2.5 text-right">${fmt.usd(p.tvl)}</td>
      <td class="px-4 py-2.5 text-right">${fmt.usd(p.volume_24h || p.volume)}</td>
      <td class="px-4 py-2.5 text-right">${p.volatility != null ? Number(p.volatility).toFixed(2) : "—"}</td>
      <td class="px-4 py-2.5 text-right">${p.bin_step || "—"}</td>
      <td class="px-4 py-2.5 text-right">${p.organic_score != null ? Math.round(p.organic_score) : "—"}</td>
      <td class="px-4 py-2.5 text-right">${p.fee_tvl_ratio != null ? Number(p.fee_tvl_ratio).toFixed(3) : "—"}</td>
      <td class="px-4 py-2.5 text-right">${p.apr_est ? p.apr_est.toFixed(0) + "%" : "—"}</td>
      <td class="px-4 py-2.5">${flags.join("") || `<span class="text-ink-faint">—</span>`}</td>
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
  const filtered = _activityCache.filter((item) => {
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
      <td class="px-4 py-2.5 font-medium">${escapeHtml(item.symbol || "—")}</td>
      <td class="px-4 py-2.5 font-mono text-[11.5px] text-ink-soft">${fmt.shortAddr(item.mint)}</td>
      <td class="px-4 py-2.5 text-ink-soft">${escapeHtml(item.reason || "—")}</td>
      <td class="px-4 py-2.5 text-ink-muted">${escapeHtml(item.added_at ? fmt.age(item.added_at) : "—")}</td>
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
async function refresh() {
  const start = Date.now();
  const [status, wallet, positions, performance, candidates, activity, configRes, blacklist] = await Promise.all([
    fetchJson("/api/status"),
    fetchJson("/api/wallet"),
    fetchJson("/api/positions"),
    fetchJson("/api/performance"),
    fetchJson("/api/candidates"),
    fetchJson("/api/activity"),
    fetchJson("/api/config"),
    fetchJson("/api/blacklist"),
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

  setMockMode(anyMock);
  $("#updated-at").textContent = `${new Date().toLocaleTimeString()} · ${Date.now() - start}ms`;
}

refresh();
setInterval(refresh, REFRESH_MS);
