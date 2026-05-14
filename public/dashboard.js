// Meridian dashboard — vanilla JS. Polls /api/* every REFRESH_MS and re-renders.
// No build step, no framework, no bundler. Single file.

const REFRESH_MS = 10_000;
let _dailyChart = null;
let _mockShown = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const fmt = {
  usd: (n) => n == null || Number.isNaN(+n) ? "—" : `$${(+n).toFixed(2)}`,
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
  shortAddr: (a) => !a ? "—" : (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a),
};

// ─── Tab switching ─────────────────────────────────────
$$(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    $$(".tab-panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $(`#tab-${t.dataset.tab}`).classList.add("active");
  });
});

// ─── Mock banner helper ────────────────────────────────
function setMockMode(on) {
  $("#mock-banner").classList.toggle("hidden", !on);
  _mockShown = on;
}

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

// ─── Renderers ─────────────────────────────────────────

function renderStatus(s) {
  if (!s) return;
  // Mode pill
  const mode = $("#mode-pill");
  mode.textContent = s.mode === "DRY_RUN" ? "DRY RUN" : "LIVE";
  mode.className = `pill ${s.mode === "DRY_RUN" ? "dry" : "live"}`;
  $("#ctl-mode").textContent = s.mode;

  // Emergency pill
  const ep = $("#emergency-pill");
  ep.classList.toggle("hidden", !s.emergency_stop);

  // Rate pill (hourly)
  const rate = s.deploy_rate || { lastHour: 0, lastDay: 0 };
  $("#rate-pill").textContent = `${rate.lastHour}/h · ${rate.lastDay}/d`;
  $("#ctl-rate-hour").textContent = rate.lastHour;
  $("#ctl-rate-day").textContent = rate.lastDay;

  if (s.models) {
    $("#ctl-models").textContent = `${s.models.screening} · ${s.models.management} · ${s.models.general}`;
  }
  if (s.uptime_ms != null) {
    $("#ctl-uptime").textContent = fmt.uptime(s.uptime_ms);
  }
}

function renderWallet(w) {
  if (!w) return;
  $("#ov-wallet-sol").textContent = fmt.sol(w.sol);
  $("#ov-wallet-usd").textContent = fmt.usd(w.sol_usd);
}

function renderPositions(p) {
  const list = $("#positions-list");
  list.innerHTML = "";
  const positions = p?.positions || [];
  $("#positions-empty").classList.toggle("hidden", positions.length > 0);
  $("#ov-positions-count").textContent = positions.length;

  let totalValue = 0;
  let totalUnclaimed = 0;
  let totalClaimed = 0;
  for (const pos of positions) {
    totalValue += Number(pos.total_value_usd) || 0;
    totalUnclaimed += Number(pos.unclaimed_fees_usd) || 0;
    totalClaimed += Number(pos.collected_fees_usd) || 0;

    const card = document.createElement("div");
    card.className = "position-card";

    const pnlClass = (Number(pos.pnl_pct) || 0) >= 0 ? "positive" : "negative";
    const oor = !pos.in_range;
    const rangeSize = (pos.upper_bin - pos.lower_bin) || 1;
    const activePos = Math.max(0, Math.min(1, (pos.active_bin - pos.lower_bin) / rangeSize));

    card.innerHTML = `
      <div class="position-head">
        <span class="pair">${escapeHtml(pos.pair || "?")}</span>
        <span class="pnl ${pnlClass}">${fmt.pctSigned(pos.pnl_pct)} · ${fmt.usdSigned(pos.pnl_usd)}</span>
      </div>
      <div class="position-meta">
        <span>Value: ${fmt.usd(pos.total_value_usd)}</span>
        <span>Unclaimed: ${fmt.usd(pos.unclaimed_fees_usd)}</span>
        <span>Claimed: ${fmt.usd(pos.collected_fees_usd)}</span>
        <span>Age: ${pos.age_minutes != null ? pos.age_minutes + " min" : "—"}</span>
        ${oor ? `<span class="badge warn">OOR ${pos.minutes_out_of_range || 0}m</span>` : `<span class="badge ok">in range</span>`}
      </div>
      <div class="position-bar">
        <div class="fill ${oor ? "oor" : ""}" style="width: ${(activePos * 100).toFixed(1)}%"></div>
      </div>
      <div class="position-bar-labels">
        <span>bin ${pos.lower_bin}</span>
        <span class="mono">${fmt.shortAddr(pos.position)}</span>
        <span>bin ${pos.upper_bin}</span>
      </div>
    `;
    list.appendChild(card);
  }

  $("#ov-positions-value").textContent = `value ${fmt.usd(totalValue)}`;
  $("#ov-unclaimed-fees").textContent = fmt.usd(totalUnclaimed);
  $("#ov-claimed-fees").textContent = `claimed ${fmt.usd(totalClaimed)}`;
}

function renderPerformance(p) {
  if (!p?.summary) return;
  const s = p.summary;
  const pnlEl = $("#ov-total-pnl");
  pnlEl.textContent = fmt.usdSigned(s.total_pnl_usd);
  pnlEl.classList.toggle("positive", s.total_pnl_usd >= 0);
  pnlEl.classList.toggle("negative", s.total_pnl_usd < 0);
  $("#ov-win-rate").textContent = `win rate ${fmt.pct(s.win_rate_pct)} · ${s.total_closes} closes`;

  // Daily chart
  drawDailyChart(p.daily || []);
}

function drawDailyChart(daily) {
  const ctx = $("#daily-pnl-chart")?.getContext?.("2d");
  if (!ctx || typeof Chart === "undefined") return;
  // Take last 30 days
  const slice = daily.slice(-30);
  const labels = slice.map((d) => d.date.slice(5));
  const values = slice.map((d) => Number(d.pnl_usd) || 0);
  const colors = values.map((v) => v >= 0 ? "#4ade80" : "#f87171");
  if (_dailyChart) {
    _dailyChart.data.labels = labels;
    _dailyChart.data.datasets[0].data = values;
    _dailyChart.data.datasets[0].backgroundColor = colors;
    _dailyChart.update("none");
    return;
  }
  _dailyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "PnL ($)",
        data: values,
        backgroundColor: colors,
        borderWidth: 0,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#79839a", font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: "#79839a", font: { size: 10 } }, grid: { color: "#1d2330" } },
      },
    },
  });
}

function renderCandidates(c) {
  const tbody = $("#candidates-table tbody");
  tbody.innerHTML = "";
  const stale = $("#candidates-stale");
  const table = $("#candidates-table");
  const items = c?.candidates || [];
  if (items.length === 0) {
    stale.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  stale.classList.add("hidden");
  table.classList.remove("hidden");
  for (const p of items) {
    const tr = document.createElement("tr");
    const flags = [];
    if (p.bundle_pct != null && p.bundle_pct > 35) flags.push('<span class="badge warn">bundle</span>');
    if (p.bot_holders_pct != null && p.bot_holders_pct > 35) flags.push('<span class="badge warn">bots</span>');
    if (p.top10_pct != null && p.top10_pct > 70) flags.push('<span class="badge bad">top10</span>');
    if (p.smart_wallets_present) flags.push('<span class="badge ok">smart$</span>');
    tr.innerHTML = `
      <td><strong>${escapeHtml(p.pair || p.name || "?")}</strong><br><span class="muted small mono">${fmt.shortAddr(p.pool_address || p.address)}</span></td>
      <td>${fmt.usd(p.tvl)}</td>
      <td>${fmt.usd(p.volume_24h || p.volume)}</td>
      <td>${p.volatility != null ? Number(p.volatility).toFixed(2) : "—"}</td>
      <td>${p.bin_step || "—"}</td>
      <td>${p.organic_score != null ? Math.round(p.organic_score) : "—"}</td>
      <td>${p.fee_tvl_ratio != null ? Number(p.fee_tvl_ratio).toFixed(3) : "—"}</td>
      <td>${flags.join(" ") || "—"}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderActivity(a) {
  const list = $("#activity-list");
  list.innerHTML = "";
  const items = a?.entries || [];
  $("#activity-count").textContent = `(${items.length})`;
  for (const item of items.slice(0, 100)) {
    const row = document.createElement("div");
    const type = String(item.type || "log").toLowerCase();
    row.className = `activity-row type-${type}`;
    const ts = item.at || item.timestamp || item.ts || item.recorded_at;
    row.innerHTML = `
      <span class="ts">${ts ? ts.slice(0, 19).replace("T", " ") : "—"}</span>
      <span class="type">${escapeHtml(type)}</span>
      <span class="body">${escapeHtml(item.reason || item.message || item.summary || JSON.stringify(item).slice(0, 240))}</span>
    `;
    list.appendChild(row);
  }
}

function renderConfig(c) {
  if (!c) return;
  renderKV($("#settings-models"), c.llm);
  renderKV($("#settings-risk"), c.risk);
  renderKV($("#settings-mgmt"), c.management);
  renderKV($("#settings-integ"), c.integrations);
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
    else if (typeof v === "object") displayV = JSON.stringify(v);
    else displayV = String(v);
    row.innerHTML = `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(displayV)}</span>`;
    el.appendChild(row);
  }
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ─── Emergency stop actions ───────────────────────────
async function doEmergencyStop() {
  const password = prompt("DASHBOARD_PASSWORD to activate emergency stop:");
  if (!password) return;
  const auth = "Basic " + btoa(`admin:${password}`);
  const res = await fetchJson("/api/emergency-stop", { method: "POST", headers: { Authorization: auth } });
  if (res.ok) {
    alert("🛑 Emergency stop ACTIVATED. No new deploys until cleared.");
    refresh();
  } else {
    alert(`Failed: ${res.error || res.status}`);
  }
}

async function doResume() {
  const password = prompt("DASHBOARD_PASSWORD to clear emergency stop:");
  if (!password) return;
  const auth = "Basic " + btoa(`admin:${password}`);
  const res = await fetchJson("/api/resume", { method: "POST", headers: { Authorization: auth } });
  if (res.ok) {
    alert("▶ Emergency stop cleared.");
    refresh();
  } else {
    alert(`Failed: ${res.error || res.status}`);
  }
}

$("#btn-emergency-stop").addEventListener("click", doEmergencyStop);
$("#btn-resume").addEventListener("click", doResume);
$("#refresh-btn").addEventListener("click", () => refresh(true));

// ─── Main refresh loop ────────────────────────────────
async function refresh() {
  const start = Date.now();
  const [status, wallet, positions, performance, candidates, activity, configRes] = await Promise.all([
    fetchJson("/api/status"),
    fetchJson("/api/wallet"),
    fetchJson("/api/positions"),
    fetchJson("/api/performance"),
    fetchJson("/api/candidates"),
    fetchJson("/api/activity"),
    fetchJson("/api/config"),
  ]);

  let anyMock = false;
  if (status.ok) renderStatus(status.data); else anyMock = true;
  if (wallet.ok) renderWallet(wallet.data); else anyMock = true;
  if (positions.ok) renderPositions(positions.data); else anyMock = true;
  if (performance.ok) renderPerformance(performance.data); else anyMock = true;
  if (candidates.ok) renderCandidates(candidates.data); else anyMock = true;
  if (activity.ok) renderActivity(activity.data); else anyMock = true;
  if (configRes.ok) renderConfig(configRes.data); else anyMock = true;

  setMockMode(anyMock);
  $("#updated-at").textContent = new Date().toLocaleTimeString() + " · " + (Date.now() - start) + "ms";
}

// Start
refresh();
setInterval(refresh, REFRESH_MS);
