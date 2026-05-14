// Meridian dashboard — vanilla JS. Polls /api/* every REFRESH_MS and re-renders.
// No build step, no framework. Single file.

const REFRESH_MS = 10_000;
let _perfChart = null;
let _perfMode = "daily";       // daily | weekly | cumulative
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
  num: (n) => n == null ? "—" : (+n).toLocaleString(undefined, { maximumFractionDigits: 2 }),
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
  shortAddr: (a) => !a ? "—" : (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a),
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

// ─── Tab switching ─────────────────────────────────────
$$(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    $$(".tab-panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $(`#tab-${t.dataset.tab}`).classList.add("active");
  });
});

// ─── Fetch wrapper ─────────────────────────────────────
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

function setMockMode(on) {
  $("#mock-banner").classList.toggle("hidden", !on);
}

// ─── Status ────────────────────────────────────────────
function renderStatus(s) {
  if (!s) return;
  const mode = $("#mode-pill");
  mode.textContent = s.mode === "DRY_RUN" ? "DRY RUN" : "LIVE";
  mode.className = `pill ${s.mode === "DRY_RUN" ? "dry" : "live"}`;
  $("#ctl-mode").textContent = s.mode;

  $("#emergency-pill").classList.toggle("hidden", !s.emergency_stop);

  const rate = s.deploy_rate || { lastHour: 0, lastDay: 0 };
  $("#rate-pill").textContent = `${rate.lastHour}/h · ${rate.lastDay}/d`;
  $("#rate-pill").className = "pill ghost";
  $("#ctl-rate-hour").textContent = rate.lastHour;
  $("#ctl-rate-day").textContent = rate.lastDay;

  if (s.models) {
    $("#ctl-models").textContent = `${s.models.screening} · ${s.models.management} · ${s.models.general}`;
  }
  if (s.uptime_ms != null) {
    $("#ctl-uptime").textContent = fmt.uptime(s.uptime_ms);
  }
  if (s.schedule) {
    $("#ctl-schedule").textContent =
      `mgmt ${s.schedule.management_interval_min}m · screen ${s.schedule.screening_interval_min}m`;
  }
  // Cache integrations for Settings → System status
  _statusCache = s;
}

let _statusCache = null;
let _configCache = null;

// ─── Wallet ────────────────────────────────────────────
function renderWallet(w) {
  if (!w) return;
  $("#ov-wallet-sol").textContent = fmt.sol(w.sol);
  $("#ov-wallet-usd").textContent = fmt.usd(w.total_usd ?? w.sol_usd);
}

// ─── Positions ─────────────────────────────────────────
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

  $("#ov-positions-value").textContent = `value ${fmt.usd(totalValue)}`;
  $("#ov-unclaimed-fees").textContent = fmt.usd(totalUnclaimed);
  $("#ov-claimed-fees").textContent = `claimed ${fmt.usd(totalClaimed)}`;
  $("#positions-summary").textContent =
    `${positions.length} open · ${fmt.usd(totalValue)} value · ${fmt.usd(totalClaimed + totalUnclaimed)} total fees`;
}

function buildPositionCard(pos) {
  const card = document.createElement("div");
  card.className = "position-card";
  if (!pos.in_range) card.classList.add("oor");

  const pnlClass = (Number(pos.pnl_pct) || 0) >= 0 ? "positive" : "negative";

  // Compute impermanent-loss proxy: pnl_usd - fees_earned (the residual price-move portion).
  // Not an exact IL number, but tells the operator whether fees are covering price drift.
  const feesUsd = (Number(pos.collected_fees_usd) || 0) + (Number(pos.unclaimed_fees_usd) || 0);
  const ilProxy = (Number(pos.pnl_usd) || 0) - feesUsd;

  // Range progress: where active_bin sits within [lower_bin, upper_bin]
  const rangeSize = (pos.upper_bin - pos.lower_bin) || 1;
  const activeFrac = Math.max(0, Math.min(1, (pos.active_bin - pos.lower_bin) / rangeSize));

  // Management recommendation — heuristic, frontend-only
  const rec = recommendationFor(pos);

  const oorTag = !pos.in_range
    ? `<span class="badge warn">OOR ${pos.minutes_out_of_range ?? 0}m</span>`
    : `<span class="badge ok">in range</span>`;

  card.innerHTML = `
    <div class="position-head">
      <div>
        <div class="pair">${escapeHtml(pos.pair || "?")}</div>
        <div class="muted small mono" style="margin-top:2px;">${fmt.shortAddr(pos.position)}</div>
      </div>
      <div class="pnl ${pnlClass}">${fmt.pctSigned(pos.pnl_pct)} · ${fmt.usdSigned(pos.pnl_usd)}</div>
    </div>
    <div class="position-meta">
      <span class="kv"><span>Value</span><span class="v">${fmt.usd(pos.total_value_usd)}</span></span>
      <span class="kv"><span>Unclaimed</span><span class="v">${fmt.usd(pos.unclaimed_fees_usd)}</span></span>
      <span class="kv"><span>Claimed</span><span class="v">${fmt.usd(pos.collected_fees_usd)}</span></span>
      <span class="kv"><span>Fees total</span><span class="v">${fmt.usd(feesUsd)}</span></span>
      <span class="kv"><span>IL proxy</span><span class="v ${ilProxy >= 0 ? "positive" : "negative"}">${fmt.usdSigned(ilProxy)}</span></span>
      <span class="kv"><span>Age</span><span class="v">${pos.age_minutes != null ? pos.age_minutes + "m" : "—"}</span></span>
      ${oorTag}
    </div>
    <div class="position-bar">
      <div class="fill ${!pos.in_range ? "oor" : ""}" style="width: ${(activeFrac * 100).toFixed(1)}%"></div>
      <div class="marker" style="left: ${(activeFrac * 100).toFixed(1)}%"></div>
    </div>
    <div class="position-bar-labels">
      <span>bin ${pos.lower_bin}</span>
      <span class="mono">active ${pos.active_bin}</span>
      <span>bin ${pos.upper_bin}</span>
    </div>
    <div class="position-rec ${rec.severity}">
      <span class="rec-label">${rec.label}</span>${escapeHtml(rec.text)}
    </div>
  `;
  return card;
}

function recommendationFor(pos) {
  const pnlPct = Number(pos.pnl_pct) || 0;
  const oorMin = Number(pos.minutes_out_of_range) || 0;
  const inRange = !!pos.in_range;
  if (!inRange && oorMin >= 20) {
    return { severity: "warn", label: "OOR", text: `Out of range ${oorMin}m — management cycle will close on next pass (threshold ~20m).` };
  }
  if (!inRange) {
    return { severity: "warn", label: "OOR", text: `Out of range ${oorMin}m — may return; will be closed if it stays out >${20}m.` };
  }
  if (pnlPct >= 5) {
    return { severity: "ok", label: "Trailing", text: `Above trailing trigger — protected by trailing TP. Sit tight unless yield drops.` };
  }
  if (pnlPct <= -10) {
    return { severity: "bad", label: "At risk", text: `Approaching stop-loss zone. Watch closely; consider manual close if conviction is gone.` };
  }
  return { severity: "ok", label: "OK", text: `In range, healthy PnL. Let the agent manage it.` };
}

// ─── Performance ───────────────────────────────────────
let _perfDataCache = null;
function renderPerformance(p) {
  if (!p) return;
  _perfDataCache = p;
  const s = p.summary || {};
  const pnlEl = $("#ov-total-pnl");
  pnlEl.textContent = fmt.usdSigned(s.total_pnl_usd);
  pnlEl.classList.toggle("positive", s.total_pnl_usd >= 0);
  pnlEl.classList.toggle("negative", s.total_pnl_usd < 0);
  $("#ov-win-rate").textContent = `win rate ${fmt.pct(s.win_rate_pct)} · ${s.total_closes} closes`;

  $("#rolling-7d").textContent = fmt.usdSigned(s.pnl_7d_usd);
  $("#rolling-7d").classList.toggle("positive", (s.pnl_7d_usd || 0) >= 0);
  $("#rolling-7d").classList.toggle("negative", (s.pnl_7d_usd || 0) < 0);
  $("#rolling-7d-count").textContent = `${s.closes_7d || 0} closes`;

  $("#rolling-30d").textContent = fmt.usdSigned(s.pnl_30d_usd);
  $("#rolling-30d").classList.toggle("positive", (s.pnl_30d_usd || 0) >= 0);
  $("#rolling-30d").classList.toggle("negative", (s.pnl_30d_usd || 0) < 0);
  $("#rolling-30d-count").textContent = `${s.closes_30d || 0} closes`;

  $("#rolling-avg").textContent = fmt.pctSigned(s.avg_pnl_pct);
  $("#rolling-avg").classList.toggle("positive", (s.avg_pnl_pct || 0) >= 0);
  $("#rolling-avg").classList.toggle("negative", (s.avg_pnl_pct || 0) < 0);

  drawPerfChart();
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

  const datasetCommon = chartType === "line"
    ? {
        label: "Cumulative PnL ($)", data: values,
        borderColor: "#7aa2ff", backgroundColor: "rgba(122, 162, 255, 0.16)",
        borderWidth: 2, fill: true, tension: 0.25, pointRadius: 0,
        pointHoverRadius: 4,
      }
    : { label: "PnL ($)", data: values, backgroundColor: colors, borderWidth: 0, borderRadius: 4 };

  _perfChart = new Chart(ctx, {
    type: chartType,
    data: { labels, datasets: [datasetCommon] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
      scales: {
        x: { ticks: { color: "#828ba0", font: { size: 10 } }, grid: { display: false }, border: { display: false } },
        y: { ticks: { color: "#828ba0", font: { size: 10 } }, grid: { color: "#1d2330" }, border: { display: false } },
      },
    },
  });
}

$$("#perf-mode .seg-btn").forEach((b) => {
  b.addEventListener("click", () => {
    $$("#perf-mode .seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    _perfMode = b.dataset.mode;
    drawPerfChart();
  });
});

// ─── Candidates ────────────────────────────────────────
function renderCandidates(c) {
  _candidatesCache = (c?.candidates || []).map((p) => ({
    ...p,
    apr_est: (Number(p.fee_tvl_ratio) || 0) * 365 * 100,
  }));
  $("#screening-meta").textContent = c?.stale
    ? "No fresh candidates"
    : `${_candidatesCache.length} candidates from latest screen`;
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
    const flags = [];
    if (p.bundle_pct != null && p.bundle_pct > 35) flags.push('<span class="badge warn">bundle</span>');
    if (p.bot_holders_pct != null && p.bot_holders_pct > 35) flags.push('<span class="badge warn">bots</span>');
    if (p.top10_pct != null && p.top10_pct > 70) flags.push('<span class="badge bad">top10</span>');
    if (p.smart_wallets_present) flags.push('<span class="badge ok">smart$</span>');
    if (p.launchpad) flags.push(`<span class="badge muted">${escapeHtml(p.launchpad)}</span>`);
    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(p.pair || p.name || "?")}</strong>
        <div class="muted small mono">${fmt.shortAddr(p.pool_address || p.address)}</div>
      </td>
      <td class="num">${fmt.usd(p.tvl)}</td>
      <td class="num">${fmt.usd(p.volume_24h || p.volume)}</td>
      <td class="num">${p.volatility != null ? Number(p.volatility).toFixed(2) : "—"}</td>
      <td class="num">${p.bin_step || "—"}</td>
      <td class="num">${p.organic_score != null ? Math.round(p.organic_score) : "—"}</td>
      <td class="num">${p.fee_tvl_ratio != null ? Number(p.fee_tvl_ratio).toFixed(3) : "—"}</td>
      <td class="num">${p.apr_est ? p.apr_est.toFixed(0) + "%" : "—"}</td>
      <td>${flags.join(" ") || "—"}</td>
    `;
    tbody.appendChild(tr);
  }
}

// Sortable header
$$("#candidates-table thead th").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (!key) return;
    if (_candidatesSort.key === key) {
      _candidatesSort.dir = _candidatesSort.dir === "asc" ? "desc" : "asc";
    } else {
      _candidatesSort = { key, dir: "desc" };
    }
    $$("#candidates-table thead th").forEach((x) => x.classList.remove("sorted-asc", "sorted-desc"));
    th.classList.add(_candidatesSort.dir === "asc" ? "sorted-asc" : "sorted-desc");
    drawCandidatesTable();
  });
});

// ─── Activity ──────────────────────────────────────────
function renderActivity(a) {
  _activityCache = a?.entries || [];
  $("#tab-count-activity").textContent = _activityCache.length || "";
  $("#activity-summary").textContent = `${_activityCache.length} recent events`;
  drawActivityList();
}

function drawActivityList() {
  const list = $("#activity-list");
  list.innerHTML = "";
  const filter = _activityFilter;
  const q = _activitySearch.toLowerCase();
  const filtered = _activityCache.filter((item) => {
    const type = String(item.type || "").toLowerCase();
    if (filter !== "all") {
      if (filter === "error" && !/error|fail/i.test(JSON.stringify(item))) return false;
      else if (filter !== "error" && type !== filter) return false;
    }
    if (q) {
      const blob = (item.summary || "") + " " + (item.reason || "") + " " + (item.pool_name || "") + " " + (item.actor || "") + " " + (item.message || "");
      if (!blob.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">No matching activity.</div>';
    return;
  }

  for (const item of filtered.slice(0, 200)) {
    const row = document.createElement("div");
    const type = String(item.type || "log").toLowerCase();
    row.className = `activity-row type-${type}`;
    const ts = item.at || item.timestamp || item.ts || item.recorded_at;
    const body = item.summary || item.reason || item.message
      || (item.actor && item.pool_name ? `${item.actor}: ${item.pool_name}` : null)
      || JSON.stringify(item).slice(0, 240);
    row.innerHTML = `
      <span class="ts">${escapeHtml(fmt.date(ts))}</span>
      <span class="type">${escapeHtml(type)}</span>
      <span class="body">${escapeHtml(body)}</span>
    `;
    list.appendChild(row);
  }
}

$$("#activity-filters .chip").forEach((c) => {
  c.addEventListener("click", () => {
    $$("#activity-filters .chip").forEach((x) => x.classList.remove("active"));
    c.classList.add("active");
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
  $("#blacklist-summary").textContent = `${items.length} blacklisted token${items.length === 1 ? "" : "s"}`;
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
    tr.innerHTML = `
      <td><strong>${escapeHtml(item.symbol || "—")}</strong></td>
      <td class="mono">${fmt.shortAddr(item.mint)}</td>
      <td>${escapeHtml(item.reason || "—")}</td>
      <td class="muted">${escapeHtml(item.added_at ? fmt.age(item.added_at) : "—")}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ─── Config / Settings ─────────────────────────────────
function renderConfig(c) {
  if (!c) return;
  _configCache = c;
  renderKV($("#settings-models"), c.llm);
  renderKV($("#settings-risk"), c.risk);
  renderKV($("#settings-mgmt"), c.management);
  renderKV($("#settings-screening"), c.screening);
  renderSettingsHealth(c);
}

function renderSettingsHealth(c) {
  const el = $("#settings-health");
  if (!el) return;
  el.innerHTML = "";
  const integ = c.integrations || {};
  const rpcHost = integ.rpc_endpoint_host || "—";
  const llmHost = integ.llm_endpoint_host || "—";
  const rows = [
    { label: "Mode", pill: c.mode === "DRY_RUN" ? { cls: "dry", text: "DRY RUN" } : { cls: "live", text: "LIVE" } },
    { label: "Emergency stop", pill: c.risk?.emergencyStop ? { cls: "danger", text: "ACTIVE" } : { cls: "ok", text: "OFF" } },
    { label: "RPC endpoint", pill: { cls: rpcHost === "—" ? "off" : "ok", text: rpcHost } },
    { label: "LLM endpoint", pill: { cls: llmHost === "—" ? "off" : "ok", text: llmHost } },
    { label: "Telegram", pill: integ.telegram ? { cls: "ok", text: "enabled" } : { cls: "off", text: "disabled" } },
    { label: "Helius", pill: integ.helius ? { cls: "ok", text: "enabled" } : { cls: "off", text: "disabled" } },
    { label: "HiveMind", pill: integ.hivemind ? { cls: "ok", text: "enabled" } : { cls: "off", text: "disabled" } },
  ];
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "health-row";
    row.innerHTML = `<span class="muted">${escapeHtml(r.label)}</span><span class="pill ${r.pill.cls}">${escapeHtml(r.pill.text)}</span>`;
    el.appendChild(row);
  }
}

function renderKV(el, obj) {
  if (!el) return;
  el.innerHTML = "";
  for (const [k, v] of Object.entries(obj || {})) {
    const row = document.createElement("div");
    row.className = "kv-row";
    let displayV;
    if (typeof v === "boolean") displayV = v ? "✓" : "✗";
    else if (v == null) displayV = "—";
    else if (Array.isArray(v)) displayV = v.length === 0 ? "—" : v.join(", ");
    else if (typeof v === "object") displayV = JSON.stringify(v);
    else displayV = String(v);
    row.innerHTML = `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(displayV)}</span>`;
    el.appendChild(row);
  }
}

// ─── Emergency stop actions ────────────────────────────
async function authPost(url, action) {
  const password = prompt(`DASHBOARD_PASSWORD to ${action}:`);
  if (!password) return null;
  const auth = "Basic " + btoa(`admin:${password}`);
  return fetchJson(url, { method: "POST", headers: { Authorization: auth } });
}
$("#btn-emergency-stop").addEventListener("click", async () => {
  const res = await authPost("/api/emergency-stop", "activate emergency stop");
  if (!res) return;
  if (res.ok) { alert("🛑 Emergency stop ACTIVATED."); refresh(); }
  else alert(`Failed: ${res.error || res.status}`);
});
$("#btn-resume").addEventListener("click", async () => {
  const res = await authPost("/api/resume", "clear emergency stop");
  if (!res) return;
  if (res.ok) { alert("▶ Emergency stop cleared."); refresh(); }
  else alert(`Failed: ${res.error || res.status}`);
});
$("#refresh-btn").addEventListener("click", () => refresh());

// ─── Main refresh loop ────────────────────────────────
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
