import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config, getRoleLLMConfig } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio).
// Each role (SCREENER / MANAGER / GENERAL) can override baseUrl + apiKey + model
// + temperature + maxTokens individually via user-config.json — see config.js
// getRoleLLMConfig(role).
//
// We cache one OpenAI client per (baseUrl, apiKey) pair to avoid re-creating
// HTTPS agents on every call, while still allowing different roles to point
// at different providers.
const _clientCache = new Map();
function getClientFor(baseUrl, apiKey) {
  const key = `${baseUrl}|${(apiKey || "").slice(0, 12)}`;
  let c = _clientCache.get(key);
  if (!c) {
    c = new OpenAI({ baseURL: baseUrl, apiKey: apiKey, timeout: 5 * 60 * 1000 });
    _clientCache.set(key, c);
  }
  return c;
}

// Fallback for legacy callers that don't pass a role — uses env / global config.
const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";
const DEFAULT_BASE_URL = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
const client = getClientFor(DEFAULT_BASE_URL, process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY);

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function errorHaystack(error) {
  // Some routers (opencode.ai, OpenRouter) wrap the upstream provider's real error
  // message inside error.metadata.raw or error.response.data — stringify the whole
  // thing so detector regexes can find the real reason.
  let payload = "";
  try { payload = JSON.stringify(error); } catch { /* circular */ }
  return String(error?.message || error?.error?.message || error || "") + " " + payload;
}

function isSystemRoleError(error) {
  return /invalid message role:\s*system/i.test(errorHaystack(error));
}

function isToolChoiceRequiredError(error) {
  const h = errorHaystack(error);
  // Matches all known wordings when a reasoning model rejects forced tool calls:
  //   Moonshot/Kimi: "tool_choice 'required' is incompatible with thinking enabled"
  //   DeepSeek:      "deepseek-reasoner does not support this tool_choice"
  //   Generic:       "tool_choice ... required", "invalid tool_choice"
  if (!/tool_choice/i.test(h)) return false;
  return /required/i.test(h)
      || /(incompatible|not support|does not support|invalid|unsupported)/i.test(h);
}

// "Provider down" = the whole endpoint is unreachable (DNS/connection/timeout),
// NOT a single model's upstream being degraded. HTTP 5xx (502/503/529) is
// deliberately EXCLUDED here — that means "router up, this model's upstream
// is bad" → try a same-provider sibling first. Connection-level failure
// means every same-provider sibling is doomed → jump straight to the
// alternative provider. Mirrors rpc-provider.js's transient taxonomy.
export function isProviderDown(error) {
  if (!error) return false;
  if (error.name === "AbortError" || error.code === "ETIMEDOUT" || error.code === "ECONNREFUSED"
    || error.code === "ECONNRESET" || error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
    return true;
  }
  const h = errorHaystack(error).toLowerCase();
  return (
    h.includes("fetch failed") ||
    h.includes("failed to fetch") ||
    h.includes("socket hang up") ||
    h.includes("network error") ||
    h.includes("econnrefused") ||
    h.includes("econnreset") ||
    h.includes("enotfound") ||
    h.includes("getaddrinfo") ||
    h.includes("connect timeout") ||
    h.includes("connection error") ||
    h.includes("connection refused")
  );
}

// Build the ordered per-role candidate chain:
//   [ primary, ...same-provider fallbackModels, (OpenRouter legacy stepfun), alt-provider ]
// Each entry is { baseUrl, apiKey, model, tier }. Deduped by baseUrl|model,
// order preserved. With no fallback config + non-OpenRouter this is a
// single-element list → behaviour identical to before.
export function buildLlmCandidates(roleCfg, explicitModel, isOpenRouter) {
  const base = roleCfg.baseUrl;
  const key = roleCfg.apiKey;
  const primaryModel = explicitModel || roleCfg.model || DEFAULT_MODEL;
  const seen = new Set();
  const out = [];
  const add = (baseUrl, apiKey, model, tier) => {
    if (!model) return;
    const k = `${baseUrl}|${model}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ baseUrl, apiKey, model, tier });
  };
  add(base, key, primaryModel, "primary");
  for (const m of roleCfg.fallbackModels || []) add(base, key, m, "same-provider");
  // Preserve the legacy OpenRouter-only stepfun fallback as a same-provider
  // candidate when no explicit list overrides it.
  if (isOpenRouter && config.llm.fallbackModel) add(base, key, config.llm.fallbackModel, "same-provider");
  if (roleCfg.alt) add(roleCfg.alt.baseUrl, roleCfg.alt.apiKey, roleCfg.alt.model, "alt-provider");
  return out;
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null } = options;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();
  let weightsSummary = null;
  if (agentType === "SCREENER") {
    try {
      const { getWeightsSummary } = await import("./signal-weights.js");
      const { config } = await import("./config.js");
      if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
    } catch { /* signal-weights not critical */ }
  }
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  let noToolRetryCount = 0;
  // How many times to reject a no-tool answer on a tool-required request
  // before giving up. Providers that don't honor tool_choice=required (e.g.
  // opencode.ai Zen Go) fall back to tool_choice=auto, where the model
  // occasionally answers in prose; extra retries recover most of those.
  const MAX_NO_TOOL_RETRIES = 4;

  // ── LLM candidate chain: primary → same-provider siblings → alt provider.
  // Built once (config is stable per loop). Single-element when no fallback
  // is configured on a non-OpenRouter provider → identical to prior behaviour.
  const roleCfg = getRoleLLMConfig(agentType);
  let isOpenRouter = false;
  try { isOpenRouter = /(^|\.)openrouter\.ai/i.test(new URL(roleCfg.baseUrl).hostname); } catch { /* bad URL → not openrouter */ }
  const candidates = buildLlmCandidates(roleCfg, model, isOpenRouter);
  const altIdx = candidates.findIndex((c) => c.tier === "alt-provider");
  // Tighten the per-request timeout only when fallbacks exist, so a hung
  // provider can't eat the client's 5-min default before we try the next
  // candidate. Single-candidate keeps the default (no timing change).
  const perCallTimeout = candidates.length > 1 ? { timeout: 90_000 } : undefined;
  const candHost = (c) => { try { return new URL(c.baseUrl).host; } catch { return "rpc"; } };
  let candIdx = 0;
  if (candidates.length > 1) {
    log("agent", `LLM chain [${agentType}]: ${candidates.map((c) => `${c.model}@${candHost(c)}(${c.tier})`).join(" → ")}`);
  }

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      let response;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      let toolChoice = (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";

      for (let attempt = 0; attempt < 3; attempt++) {
        // Active candidate — recomputed each attempt so a candidate advance
        // (below) rebinds client + model on the next iteration.
        const cand = candidates[candIdx];
        const roleClient = getClientFor(cand.baseUrl, cand.apiKey);
        const usedModel = cand.model;
        try {
          response = await roleClient.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            tool_choice: toolChoice,
            temperature: roleCfg.temperature,
            max_tokens: maxOutputTokens ?? roleCfg.maxTokens,
          }, perCallTimeout);
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            toolChoice = "auto";
            log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
            attempt -= 1;
            continue;
          }
          // 429 = rate limit, not provider/model death — defer to the outer
          // handler's 30s wait + step retry (unchanged behaviour).
          if (error.status === 429) throw error;
          // Recover by switching LLM candidate. Connection-level failure =
          // whole provider unreachable → jump straight to the alt provider
          // (skip doomed same-provider siblings). Else advance one.
          const next = (isProviderDown(error) && altIdx > candIdx) ? altIdx : candIdx + 1;
          if (next < candidates.length) {
            const from = candidates[candIdx];
            const to = candidates[next];
            candIdx = next;
            log("agent", `LLM fallback ${from.model}@${candHost(from)} → ${to.model}@${candHost(to)} (${to.tier}) on: ${String(error.message || error).slice(0, 140)}`);
            attempt -= 1;
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          // Router reachable but this model's upstream is degraded → prefer
          // a same-provider sibling (next candidate) before any backoff.
          const next = candIdx + 1;
          if (next < candidates.length) {
            const from = candidates[candIdx];
            const to = candidates[next];
            candIdx = next;
            log("agent", `LLM fallback ${from.model}@${candHost(from)} → ${to.model}@${candHost(to)} (${to.tier}) on provider error ${errCode}`);
            attempt -= 1;
            continue;
          }
          const wait = (attempt + 1) * 5000;
          log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
          await new Promise((r) => setTimeout(r, wait));
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      const invalidToolArgErrors = new Map();
      // Keep tool-call history API-valid, but never execute unrecoverable args.
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                const error = `Invalid tool arguments for ${tc.function.name}`;
                invalidToolArgErrors.set(tc.id, error);
                log("error", `${error}: could not repair JSON`);
              }
            }
          }
        }
      }
      // Reasoning models (Kimi K2.6 thinking mode, etc.) have an asymmetric protocol.
      // RESPONSE field name varies by upstream:
      //   Fireworks-hosted Kimi → `reasoning_content` (string)
      //   Moonshot-hosted Kimi  → `reasoning` + `reasoning_details` (and `refusal`)
      // REQUEST always requires `reasoning_content` (string) on any assistant message
      // that carries tool_calls; the other names are rejected as "Extra inputs".
      // → Strip the rejected names; ALWAYS include reasoning_content (empty string ok)
      //   on tool-call messages, normalizing from whichever response variant we got.
      const historyMsg = { role: msg.role, content: msg.content ?? null };
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        historyMsg.tool_calls = msg.tool_calls;
        historyMsg.reasoning_content = msg.reasoning_content || msg.reasoning || "";
      }
      if (msg.name) historyMsg.name = msg.name;
      messages.push(historyMsg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/${MAX_NO_TOOL_RETRIES}) for tool-required request`);
          if (noToolRetryCount >= MAX_NO_TOOL_RETRIES) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
              : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        if (invalidToolArgErrors.has(toolCall.id)) {
          const result = {
            success: false,
            error: invalidToolArgErrors.get(toolCall.id),
            blocked: true,
          };
          await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
        }

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            const result = {
              success: false,
              error: `Invalid tool arguments for ${functionName}`,
              blocked: true,
            };
            await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
            return {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);
      const bodyText = error?.response?.data
        ? JSON.stringify(error.response.data).slice(0, 1500)
        : (error?.error ? JSON.stringify(error.error).slice(0, 1500) : null);
      if (bodyText) log("error", `Provider body: ${bodyText}`);
      if (error?.status) log("error", `HTTP status: ${error.status}  Model: ${model || DEFAULT_MODEL}  Msg count: ${messages.length}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
