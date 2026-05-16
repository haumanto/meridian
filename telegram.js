import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";
import { paths } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = paths.userConfigPath;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

// ─── getUpdates offset persistence ───────────────────────────────
// The Telegram update offset must survive restarts AND only advance
// once a message has actually been handled — otherwise a command in
// flight during a restart is confirmed-and-dropped (silent miss).
let OFFSET_PATH = paths.telegramOffsetPath;

function loadOffset() {
  try {
    if (fs.existsSync(OFFSET_PATH)) {
      const o = JSON.parse(fs.readFileSync(OFFSET_PATH, "utf8"))?.offset;
      if (Number.isInteger(o) && o >= 0) _offset = o;
    }
  } catch (e) {
    log("telegram_warn", `Invalid telegram-offset.json; resuming from 0: ${e.message}`);
  }
}

function saveOffset() {
  try {
    fs.writeFileSync(OFFSET_PATH, JSON.stringify({ offset: _offset }));
  } catch (e) {
    log("telegram_error", `Failed to persist Telegram offset: ${e.message}`);
  }
}

loadOffset();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== chatId) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      // Surface this back to the operator ONCE so they don't wonder why /commands stop working
      // when the bot is moved to a group. Best-effort; won't fail the gate if Telegram is down.
      sendMessage(
        "⚠️ Commands ignored in this chat — TELEGRAM_ALLOWED_USER_IDS is not configured. " +
        "Set the comma-separated list of allowed Telegram user IDs in .env and restart the agent."
      ).catch(() => {});
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) {
      // Per-user denial reply: tells the operator their account isn't allowlisted
      // without spamming the chat when a stranger tries commands.
      const denyKey = `${incomingChatId}:${senderUserId}`;
      if (!_deniedUserSet.has(denyKey)) {
        _deniedUserSet.add(denyKey);
        log("telegram_warn", `Denied command from non-allowlisted user ${senderUserId} in chat ${incomingChatId}`);
        sendMessage(
          `🔒 User ${senderUserId} is not authorized. Add the ID to TELEGRAM_ALLOWED_USER_IDS in .env and restart.`
        ).catch(() => {});
      }
      return false;
    }
  }

  return true;
}

const _deniedUserSet = new Set();

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

// Canonical command list for Telegram's native "/" menu. One entry per
// distinct handler — pure aliases (status→wallet, menu/configmenu→settings,
// emergency-stop/emergencystop→emergency_stop) are omitted from the menu but
// still accepted when typed. Names MUST match ^[a-z0-9_]{1,32}$ and
// descriptions be 1–256 chars, or Telegram rejects the whole setMyCommands.
export function buildBotCommands() {
  return [
    { command: "help", description: "Show all commands" },
    { command: "wallet", description: "Wallet balance + open positions" },
    { command: "positions", description: "List open positions" },
    { command: "pool", description: "Details for a position — /pool N" },
    { command: "close", description: "Close a position — /close N" },
    { command: "closeall", description: "Close all open positions" },
    { command: "set", description: "Set a note on a position — /set N note" },
    { command: "config", description: "Show runtime config" },
    { command: "settings", description: "Open the config editor menu" },
    { command: "setcfg", description: "Set a config key — /setcfg key value" },
    { command: "screen", description: "Run a screening cycle now" },
    { command: "candidates", description: "Show current candidates" },
    { command: "deploy", description: "Deploy a candidate — /deploy N" },
    { command: "briefing", description: "Daily briefing (last 24h)" },
    { command: "hive", description: "HiveMind status — /hive pull to sync" },
    { command: "pause", description: "Pause autonomous cycles" },
    { command: "emergency_stop", description: "Halt all new deploys (persists)" },
    { command: "resume", description: "Resume cycles / clear emergency stop" },
    { command: "optimize", description: "Analyse performance & propose tuning (tap to apply)" },
  ];
}

// One-shot: publish the command menu to Telegram. Fire-and-forget; a
// failure must never block polling/trading. No chat_id (global, default
// scope) — authorization is still enforced per-message on receipt.
export async function registerBotCommands() {
  if (!TOKEN) return;
  try {
    const commands = buildBotCommands();
    const res = await postTelegramRaw("setMyCommands", { commands });
    if (res && res.ok) log("telegram", `Registered ${commands.length} Telegram commands`);
    else log("telegram_warn", "setMyCommands did not confirm — command menu may be stale");
  } catch (e) {
    log("telegram_warn", `setMyCommands failed: ${e.message}`);
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        // Advance + persist the offset only AFTER handling completes, so a
        // restart mid-handle re-delivers the update instead of dropping it
        // (at-least-once). The finally still advances on handler error to
        // avoid a poison-message loop blocking the queue.
        try {
          const callback = update.callback_query;
          if (callback?.data && callback?.message) {
            const callbackMsg = {
              chat: callback.message.chat,
              from: callback.from,
              text: callback.data,
            };
            if (isAuthorizedIncomingMessage(callbackMsg)) {
              await onMessage({
                ...callbackMsg,
                isCallback: true,
                callbackQueryId: callback.id,
                callbackData: callback.data,
                messageId: callback.message.message_id,
              });
            }
          } else {
            const msg = update.message;
            if (msg?.text && isAuthorizedIncomingMessage(msg)) {
              await onMessage(msg);
            }
          }
        } catch (e) {
          log("telegram_error", `Handler failed for update ${update.update_id}: ${e.message}`);
        } finally {
          _offset = update.update_id + 1;
          saveOffset();
        }
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  void registerBotCommands(); // publish the "/" menu (idempotent, non-blocking)
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
  if (hasActiveLiveMessage()) return;
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  await sendHTML(
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    coverageStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyClose({ pair, pnlUsd, pnlPct, reason }) {
  if (hasActiveLiveMessage()) return;
  const sign = pnlUsd >= 0 ? "+" : "";
  // solMode: the value passed is already SOL-denominated (getMyPositions
  // reads pnlSol when solMode) — just label it correctly.
  const sym = config.management?.solMode ? "◎" : "$";
  let whyStr = "";
  if (reason) {
    const trimmed = String(reason).trim().slice(0, 220);
    const escaped = trimmed
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (escaped) whyStr = `\nWhy: ${escaped}`;
  }
  await sendHTML(
    `🔒 <b>Closed</b> ${pair}\n` +
    `PnL: ${sign}${sym}${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)` +
    whyStr
  );
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${pair}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

// ─── Test hooks (offset persistence) ─────────────────────────────
export function _setOffsetPathForTest(p) { OFFSET_PATH = p; }
export function _setOffsetForTest(n) { _offset = n; }
export function _getOffsetForTest() { return _offset; }
export function _loadOffsetForTest() { _offset = 0; loadOffset(); return _offset; }
export function _saveOffsetForTest() { saveOffset(); }
