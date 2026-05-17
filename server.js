// Lightweight HTTP dashboard for Meridian.
//
// Boots only when DASHBOARD_ENABLED=true in .env. Binds to 127.0.0.1 by
// default (override with DASHBOARD_HOST). Read-only GET endpoints are
// open on the bound interface; the one mutating endpoint
// (POST /api/emergency-stop) requires HTTP Basic Auth via DASHBOARD_PASSWORD.
//
// No new framework, no React/Vue/Svelte — express + static files only.

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getDeployRateState } from "./tools/rate-limit.js";
import { listBlacklist } from "./token-blacklist.js";
import { getArSnapshot } from "./ar-dashboard.js";
import { readTransactions, reconstructFromHistory } from "./transactions-ledger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const REPO_ROOT = __dirname;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

const _startedAt = Date.now();
let _latestCandidates = []; // updated by index.js after each screening cycle

export function setLatestCandidatesForDashboard(arr) {
  _latestCandidates = Array.isArray(arr) ? arr : [];
}

// Read a JSON file with a safe fallback. Used for state/pool-memory/etc.
function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    log("dashboard_warn", `Failed to read ${p}: ${err.message}`);
    return fallback;
  }
}

// Sanitize config for display — strip wallet/API keys/Telegram tokens.
function sanitizedConfig() {
  return {
    mode: process.env.DRY_RUN === "true" ? "DRY_RUN" : "LIVE",
    llm: {
      screeningModel: config.llm.screeningModel,
      managementModel: config.llm.managementModel,
      generalModel: config.llm.generalModel,
      temperature: config.llm.temperature,
      maxTokens: config.llm.maxTokens,
    },
    risk: {
      maxPositions: config.risk.maxPositions,
      maxDeployAmount: config.risk.maxDeployAmount,
      maxDeploysPerHour: config.risk.maxDeploysPerHour,
      maxDeploysPerDay: config.risk.maxDeploysPerDay,
      emergencyStop: config.risk.emergencyStop,
    },
    management: {
      deployAmountSol: config.management.deployAmountSol,
      positionSizePct: config.management.positionSizePct,
      stopLossPct: config.management.stopLossPct,
      takeProfitPct: config.management.takeProfitPct,
      trailingTakeProfit: config.management.trailingTakeProfit,
      trailingTriggerPct: config.management.trailingTriggerPct,
      trailingDropPct: config.management.trailingDropPct,
      outOfRangeWaitMinutes: config.management.outOfRangeWaitMinutes,
      gasReserve: config.management.gasReserve,
      minSolToOpen: config.management.minSolToOpen,
    },
    screening: { ...config.screening },
    schedule: { ...config.schedule },
    integrations: {
      // Just booleans — never the actual values
      telegram: !!process.env.TELEGRAM_BOT_TOKEN,
      helius: !!process.env.HELIUS_API_KEY,
      hivemind: !!config.hiveMind?.apiKey,
      rpc_endpoint_host: process.env.RPC_URL ? new URL(process.env.RPC_URL).hostname : null,
      llm_endpoint_host: process.env.LLM_BASE_URL ? new URL(process.env.LLM_BASE_URL).hostname : "openrouter.ai",
    },
  };
}

function basicAuth(req, res, next) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    return res.status(503).json({
      error: "DASHBOARD_PASSWORD not set — refusing to expose mutating endpoint without auth",
    });
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="meridian-dashboard"');
    return res.status(401).json({ error: "Authorization required" });
  }
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return res.status(400).json({ error: "Malformed authorization header" });
  }
  const colonIdx = decoded.indexOf(":");
  if (colonIdx < 0) return res.status(400).json({ error: "Malformed authorization header" });
  const supplied = decoded.slice(colonIdx + 1);
  if (supplied !== password) {
    log("dashboard_warn", `Auth failed for ${req.ip} on ${req.method} ${req.path}`);
    return res.status(401).json({ error: "Invalid credentials" });
  }
  next();
}

export function buildApp({ executeTool } = {}) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));

  // ─── Static assets ─────────────────────────────────────
  app.use(express.static(PUBLIC_DIR, { maxAge: "1h", index: "index.html" }));

  // ─── Status / health ───────────────────────────────────
  app.get("/api/status", (req, res) => {
    res.json({
      mode: process.env.DRY_RUN === "true" ? "DRY_RUN" : "LIVE",
      sol_mode: !!config.management?.solMode,
      emergency_stop: !!config.risk.emergencyStop,
      uptime_ms: Date.now() - _startedAt,
      models: {
        screening: config.llm.screeningModel,
        management: config.llm.managementModel,
        general: config.llm.generalModel,
      },
      deploy_rate: getDeployRateState(),
      integrations: {
        telegram: !!process.env.TELEGRAM_BOT_TOKEN,
        helius: !!process.env.HELIUS_API_KEY,
        hivemind: !!config.hiveMind?.apiKey,
      },
      schedule: {
        management_interval_min: config.schedule.managementIntervalMin,
        screening_interval_min: config.schedule.screeningIntervalMin,
      },
    });
  });

  // ─── Blacklist ─────────────────────────────────────────
  app.get("/api/blacklist", (req, res) => {
    try {
      res.json(listBlacklist());
    } catch (err) {
      res.status(503).json({ error: err.message, count: 0, blacklist: [] });
    }
  });

  // ─── Wallet & positions ────────────────────────────────
  app.get("/api/wallet", async (req, res) => {
    try {
      const bal = await getWalletBalances({});
      res.json({
        wallet: bal.wallet,
        sol: bal.sol,
        sol_usd: bal.sol_usd,
        sol_price: bal.sol_price,
        usdc: bal.usdc,
        total_usd: bal.total_usd,
        tokens: (bal.tokens || []).map((t) => ({
          mint: t.mint,
          symbol: t.symbol,
          balance: t.balance,
          usd: t.usd,
        })),
      });
    } catch (err) {
      res.status(503).json({ error: err.message, mock_available: true });
    }
  });

  app.get("/api/positions", async (req, res) => {
    try {
      const data = await getMyPositions({ force: false });
      res.json(data);
    } catch (err) {
      res.status(503).json({ error: err.message, mock_available: true });
    }
  });

  // ─── Performance (closed positions) ────────────────────
  app.get("/api/performance", (req, res) => {
    const lessons = readJsonSafe(path.join(REPO_ROOT, "lessons.json"), { performance: [] });
    const closes = (lessons.performance || []).slice(-500);
    // Aggregates
    const total_pnl_usd = closes.reduce((s, p) => s + (Number(p.pnl_usd) || 0), 0);
    const wins = closes.filter((p) => Number(p.pnl_pct) > 0).length;
    const win_rate_pct = closes.length ? (wins / closes.length) * 100 : 0;
    const avg_pnl_pct = closes.length
      ? closes.reduce((s, p) => s + (Number(p.pnl_pct) || 0), 0) / closes.length
      : 0;
    // Daily / weekly / cumulative bucketing is done client-side in the
    // viewer's local timezone (see `points` below + public/dashboard.js);
    // bucketing here would lock the charts to UTC calendar days.
    // 7-day and 30-day rolling (epoch windows — timezone-neutral)
    const now = Date.now();
    const last7d = closes.filter((c) => {
      const t = Date.parse(c.recorded_at || c.closed_at);
      return !Number.isNaN(t) && now - t <= 7 * 86400_000;
    });
    const last30d = closes.filter((c) => {
      const t = Date.parse(c.recorded_at || c.closed_at);
      return !Number.isNaN(t) && now - t <= 30 * 86400_000;
    });
    const sumPnl = (arr) => arr.reduce((s, p) => s + (Number(p.pnl_usd) || 0), 0);

    res.json({
      summary: {
        total_closes: closes.length,
        total_pnl_usd: Number(total_pnl_usd.toFixed(2)),
        win_rate_pct: Number(win_rate_pct.toFixed(1)),
        avg_pnl_pct: Number(avg_pnl_pct.toFixed(2)),
        pnl_7d_usd: Number(sumPnl(last7d).toFixed(2)),
        pnl_30d_usd: Number(sumPnl(last30d).toFixed(2)),
        closes_7d: last7d.length,
        closes_30d: last30d.length,
      },
      // Raw closes for client-side, browser-local-timezone bucketing.
      points: closes.map((c) => ({
        t: c.recorded_at || c.closed_at,
        pnl_usd: Number(c.pnl_usd) || 0,
      })),
      closes: closes.slice(-50).reverse(),
    });
  });

  // ─── Candidates (last screening output) ────────────────
  app.get("/api/candidates", (req, res) => {
    res.json({
      count: _latestCandidates.length,
      candidates: _latestCandidates,
      stale: _latestCandidates.length === 0,
    });
  });

  // ─── Activity log ──────────────────────────────────────
  app.get("/api/activity", (req, res) => {
    const log = readJsonSafe(path.join(REPO_ROOT, "decision-log.json"), { decisions: [] });
    const items = (log.decisions || log.entries || log.log || []).slice(-200).reverse();
    res.json({ count: items.length, entries: items });
  });

  // ─── Transactions ledger ───────────────────────────────
  // Profile-isolated (readTransactions defaults to paths.dataDir). When
  // the real ledger is still empty (pre-first-action), fall back to a
  // best-effort reconstruction from lessons/pool-memory so the tab isn't
  // blank — flagged reconstructed so the UI renders it distinctly. No
  // Solana RPC. arSnapshotSafe-style graceful degrade.
  app.get("/api/transactions", (req, res) => {
    try {
      const t = readTransactions();
      if (t.count > 0) return res.json({ ...t, reconstructed: false });
      const lessons = readJsonSafe(path.join(REPO_ROOT, "lessons.json"), { performance: [] });
      const poolMemory = readJsonSafe(path.join(REPO_ROOT, "pool-memory.json"), {});
      const rec = reconstructFromHistory({ lessons, poolMemory });
      res.json({ count: rec.length, entries: rec.slice(-200).reverse(), reconstructed: true });
    } catch (e) {
      log("dashboard_warn", `transactions route failed: ${e.message}`);
      res.json({ count: 0, entries: [], stale: true });
    }
  });

  // ─── Config (sanitized) ────────────────────────────────
  app.get("/api/config", (req, res) => {
    res.json(sanitizedConfig());
  });

  // ─── Autoresearch (read-only view of the isolated AR instance) ──
  // Reads profiles/autoresearch/* + research/runs/<runId>/ directly;
  // never touches the path-bound singletons or the AR process. No auth
  // (read-only, no secrets — consistent with the other GET routes).
  function arSnapshotSafe() {
    try { return getArSnapshot(); } catch (e) {
      log("dashboard_warn", `AR snapshot failed: ${e.message}`);
      return { configured: false, error: "snapshot failed" };
    }
  }
  app.get("/api/ar/status", (req, res) => {
    const s = arSnapshotSafe();
    if (!s.configured) return res.json(s);
    res.json({
      configured: true, alive: s.alive, lastUpdated: s.lastUpdated,
      lastHeartbeat: s.lastHeartbeat,
      runId: s.runId, enabled: s.enabled, promptNotes: s.promptNotes,
      caps: s.caps, todayLossSol: s.todayLossSol,
      dailyLossHeadroomSol: s.dailyLossHeadroomSol,
      deploysToday: s.deploysToday, openCount: s.openCount,
      runNote: s.runNote, scoringCriteria: s.scoringCriteria,
    });
  });
  app.get("/api/ar/positions", (req, res) => {
    const s = arSnapshotSafe();
    if (!s.configured) return res.json(s);
    res.json({ configured: true, positions: s.positions, recentEvents: s.recentEvents });
  });
  app.get("/api/ar/results", (req, res) => {
    const s = arSnapshotSafe();
    if (!s.configured) return res.json(s);
    res.json({ configured: true, ...s.results });
  });

  // ─── Emergency stop (mutating, auth required) ─────────
  app.post("/api/emergency-stop", basicAuth, async (req, res) => {
    if (!executeTool) {
      return res.status(500).json({ error: "executeTool not wired" });
    }
    try {
      await executeTool(
        "update_config",
        { config: { emergencyStop: true }, reason: "Dashboard /api/emergency-stop" },
        "GENERAL"
      );
      res.json({ ok: true, emergency_stop: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/resume", basicAuth, async (req, res) => {
    if (!executeTool) {
      return res.status(500).json({ error: "executeTool not wired" });
    }
    try {
      await executeTool(
        "update_config",
        { config: { emergencyStop: false }, reason: "Dashboard /api/resume" },
        "GENERAL"
      );
      res.json({ ok: true, emergency_stop: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 404 for unmatched API routes (static fallback to index.html handled by express.static)
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "Unknown API path" });
  });

  return app;
}

/**
 * Boot the dashboard server. Called from index.js iff DASHBOARD_ENABLED=true.
 * Returns the HTTP server (so the caller can graceful-close on shutdown).
 */
export function startDashboard({ executeTool } = {}) {
  if (process.env.DASHBOARD_ENABLED !== "true") return null;

  if (!process.env.DASHBOARD_PASSWORD) {
    log("startup", "Dashboard NOT started — DASHBOARD_ENABLED=true but DASHBOARD_PASSWORD is unset (would expose /api/emergency-stop unauthenticated)");
    return null;
  }

  const host = process.env.DASHBOARD_HOST || DEFAULT_HOST;
  const port = Number(process.env.DASHBOARD_PORT || DEFAULT_PORT);

  if (host !== "127.0.0.1" && host !== "localhost") {
    log("startup", `⚠️ Dashboard binding to ${host} (non-localhost). Make sure your firewall + reverse proxy add their own auth before exposing.`);
  }

  const app = buildApp({ executeTool });
  const server = app.listen(port, host, () => {
    log("startup", `Dashboard listening at http://${host}:${port}/`);
  });
  server.on("error", (err) => {
    log("error", `Dashboard server error: ${err.message}`);
  });
  return server;
}
