import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { config } from "./config.js";
import { paths } from "./paths.js";
import { getWalletBalances } from "./tools/wallet.js";
import { fmtMoney } from "./money.js";

const STATE_FILE = paths.statePath;
const LESSONS_FILE = paths.lessonsPath;

// Calendar date (YYYY-MM-DD) and hour (0–23) "now" in an IANA timezone.
// Drives the daily-briefing schedule, the missed-briefing catch-up, and
// the "already sent today" dedupe so they all agree on the operator's
// local day boundary. An invalid tz falls back to UTC (defensive — boot
// validation already rejects bad tz, but a bad runtime /setcfg shouldn't
// crash the cron). Returns the effective `zone` actually used.
export function briefingDateParts(tz, now = new Date()) {
  let zone = tz || "UTC";
  let parts;
  try {
    parts = fmtZoneParts(zone, now);
  } catch {
    zone = "UTC";
    parts = fmtZoneParts(zone, now);
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24, // ICU may emit "24" at midnight
    zone,
  };
}

function fmtZoneParts(zone, now) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(now);
  return Object.fromEntries(p.map((x) => [x.type, x.value]));
}

// Telegram briefing is sent with parse_mode=HTML, so any free text
// interpolated into it (lesson rules etc.) must be HTML-escaped — lesson
// text now legitimately contains < / > comparison operators.
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();
  // Briefing money is USD-sourced (lessons.performance) → SOL is an
  // estimate at the current price. Fetch it once (cached, cheap).
  const _bal = await getWalletBalances().catch(() => null);
  const _px = Number(_bal?.sol_price) || 0;

  // 5. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${fmtMoney(totalPnLUsd, { solPrice: _px, signed: true })}`,
    `💎 Fees Earned: ${fmtMoney(totalFeesUsd, { solPrice: _px })}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${escapeHtml(l.rule)}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: ${fmtMoney(perfSummary.total_pnl_usd, { solPrice: _px, signed: true })} (${perfSummary.win_rate_pct}% win)`
      : "",
    _px > 0 ? `<i>≈ SOL converted at current price ($${_px.toFixed(2)}); closes are USD-recorded.</i>` : "",
    "────────────────"
  ];

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
