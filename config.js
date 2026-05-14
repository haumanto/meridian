import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bs58 from "bs58";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:        u.maxPositions        ?? 3,
    maxDeployAmount:     u.maxDeployAmount     ?? 50,
    // Safety caps added in P1 — guard against runaway deploys in volatile flash events
    maxDeploysPerHour:   u.maxDeploysPerHour   ?? 6,
    maxDeploysPerDay:    u.maxDeploysPerDay    ?? 20,
    // Emergency stop — flip via `node cli.js config set emergencyStop true` or Telegram /emergency-stop
    emergencyStop:       u.emergencyStop       ?? false,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  // Per-role config (baseUrl / apiKey / model / temperature / maxTokens) lets you
  // mix providers — e.g. OpenRouter for screening, opencode.ai for management.
  // All per-role overrides fall back to the global baseUrl/apiKey/model/etc.
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    // Per-role provider overrides (optional — fall back to global env when null)
    screeningBaseUrl:   u.screeningBaseUrl   ?? null,
    screeningApiKey:    u.screeningApiKey    ?? null,
    screeningTemperature: u.screeningTemperature ?? null,
    screeningMaxTokens: u.screeningMaxTokens ?? null,
    managementBaseUrl:  u.managementBaseUrl  ?? null,
    managementApiKey:   u.managementApiKey   ?? null,
    managementTemperature: u.managementTemperature ?? null,
    managementMaxTokens: u.managementMaxTokens ?? null,
    generalBaseUrl:     u.generalBaseUrl     ?? null,
    generalApiKey:      u.generalApiKey      ?? null,
    generalTemperature: u.generalTemperature ?? null,
    generalMaxTokens:   u.generalMaxTokens   ?? null,
    // Fallback model used on 502/503/529 (only fires on OpenRouter-shaped providers).
    // Set to null/empty string to disable the retry-with-fallback step entirely.
    fallbackModel: u.fallbackModel ?? "stepfun/step-3.5-flash:free",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Validate required boot-time configuration. Called from index.js at startup.
 * Fails fast with clear errors so the operator doesn't waste cycles diagnosing
 * a misconfiguration mid-run. Skipped when isMain is false (tests/imports).
 *
 * Checks:
 *  - WALLET_PRIVATE_KEY is present and decodable (base58 → 64 bytes, or JSON array of 64 nums)
 *  - RPC_URL is present, parses as URL, and is https (unless rpcUrlMustBeHttps disabled)
 *  - One of LLM_API_KEY or OPENROUTER_API_KEY is present
 *  - Each per-role model slug is a non-empty string
 *  - DRY_RUN env and dryRun config don't contradict each other
 *
 * @param {{ strict?: boolean, env?: Record<string,string|undefined>, userConfig?: Record<string,any>, modelConfig?: Record<string,string> }} [opts]
 * @returns {string[]} Array of human-readable error messages. Empty = pass.
 */
export function validateBoot(opts = {}) {
  const strict = opts.strict !== false;
  const env = opts.env ?? process.env;
  const userCfg = opts.userConfig ?? u;
  const modelCfg = opts.modelConfig ?? config.llm;
  const errors = [];

  // Wallet
  const walletKey = env.WALLET_PRIVATE_KEY;
  if (!walletKey) {
    if (strict) errors.push("WALLET_PRIVATE_KEY is missing — set in .env or user-config.json:walletKey");
  } else {
    let ok = false;
    if (walletKey.trim().startsWith("[")) {
      try {
        const arr = JSON.parse(walletKey);
        if (Array.isArray(arr) && arr.length === 64 && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
          ok = true;
        }
      } catch { /* fall through */ }
    } else {
      // base58 — a 64-byte Solana secret key decodes to 64 bytes (typically 87–88 chars)
      try {
        const decoded = bs58.decode(walletKey.trim());
        ok = decoded?.length === 64;
      } catch { /* fall through */ }
    }
    if (!ok) errors.push("WALLET_PRIVATE_KEY does not decode to a 64-byte Solana secret key (expected base58 or JSON int array)");
  }

  // RPC URL
  const rpcUrl = env.RPC_URL;
  const httpsRequired = userCfg.rpcUrlMustBeHttps !== false; // default: required
  if (!rpcUrl) {
    if (strict) errors.push("RPC_URL is missing — set in .env or user-config.json:rpcUrl");
  } else {
    let parsed;
    try { parsed = new URL(rpcUrl); } catch { /* invalid */ }
    if (!parsed) errors.push(`RPC_URL is not a valid URL: ${rpcUrl}`);
    else if (httpsRequired && parsed.protocol !== "https:") {
      errors.push(`RPC_URL must use https (got ${parsed.protocol}). Set rpcUrlMustBeHttps:false in user-config.json to override (not recommended).`);
    }
  }

  // LLM key (global fallback)
  const llmKey = env.LLM_API_KEY || env.OPENROUTER_API_KEY;

  // Per-role validation: each role must end up with a non-empty model slug AND
  // either a role-specific apiKey or the global LLM_API_KEY / OPENROUTER_API_KEY.
  // baseUrl falls back to https://openrouter.ai/api/v1 so it's never empty.
  const rolesMeta = [
    { role: "screening",  modelKey: "screeningModel",  apiKeyOverride: "screeningApiKey" },
    { role: "management", modelKey: "managementModel", apiKeyOverride: "managementApiKey" },
    { role: "general",    modelKey: "generalModel",    apiKeyOverride: "generalApiKey" },
  ];
  for (const r of rolesMeta) {
    const slug = modelCfg[r.modelKey];
    if (typeof slug !== "string" || !slug.trim()) {
      errors.push(`config.llm.${r.modelKey} must be a non-empty string (got ${JSON.stringify(slug)})`);
    }
    const roleApiKey = modelCfg[r.apiKeyOverride];
    const effectiveKey = roleApiKey || llmKey;
    if (!effectiveKey) {
      if (strict) {
        errors.push(`No API key resolves for role ${r.role} — set ${r.apiKeyOverride} in user-config.json, or LLM_API_KEY in .env`);
      }
    }
  }

  // DRY_RUN consistency
  const envDryRun = env.DRY_RUN;
  if (envDryRun !== undefined && userCfg.dryRun !== undefined) {
    const envBool = envDryRun === "true";
    const cfgBool = userCfg.dryRun === true;
    if (envBool !== cfgBool) {
      errors.push(`DRY_RUN env (${envDryRun}) disagrees with user-config.json:dryRun (${userCfg.dryRun}). Reconcile before booting.`);
    }
  }

  return errors;
}

/**
 * Resolve the effective LLM config for a given role.
 * Role-specific overrides take precedence; otherwise we use the global
 * LLM_BASE_URL / LLM_API_KEY / LLM_MODEL from .env, then the openrouter default.
 *
 * @param {"SCREENER"|"MANAGER"|"GENERAL"|"screening"|"management"|"general"} role
 * @returns {{ baseUrl: string, apiKey: string, model: string, temperature: number, maxTokens: number, role: string }}
 */
export function getRoleLLMConfig(role) {
  const r = String(role || "").toUpperCase();
  const l = config.llm;
  let pick;
  if (r === "SCREENER" || r === "SCREENING") {
    pick = { baseUrl: l.screeningBaseUrl, apiKey: l.screeningApiKey, model: l.screeningModel, temperature: l.screeningTemperature, maxTokens: l.screeningMaxTokens };
  } else if (r === "MANAGER" || r === "MANAGEMENT") {
    pick = { baseUrl: l.managementBaseUrl, apiKey: l.managementApiKey, model: l.managementModel, temperature: l.managementTemperature, maxTokens: l.managementMaxTokens };
  } else {
    pick = { baseUrl: l.generalBaseUrl, apiKey: l.generalApiKey, model: l.generalModel, temperature: l.generalTemperature, maxTokens: l.generalMaxTokens };
  }
  return {
    baseUrl: pick.baseUrl || process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
    apiKey: pick.apiKey || process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "",
    model: pick.model,
    temperature: pick.temperature ?? l.temperature,
    maxTokens: pick.maxTokens ?? l.maxTokens,
    role: r,
  };
}

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
