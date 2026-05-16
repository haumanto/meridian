# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project

**Meridian** — autonomous DLMM liquidity provider agent for Meteora pools on Solana. Runs continuous screening + management cron cycles driven by an LLM ReAct loop (any OpenAI-compatible provider).

---

## Setup

```bash
npm install                       # postinstall runs scripts/patch-anchor.js (patches @coral-xyz/anchor + @meteora-ag/dlmm)
cp .env.example .env              # then fill in WALLET_PRIVATE_KEY, RPC_URL, LLM credentials, Telegram
cp user-config.example.json user-config.json   # OR run `npm run setup` for interactive wizard
chmod 600 .env
```

Keep `DRY_RUN=true` in `.env` (and `"dryRun": true` in `user-config.json`) until at least 2–3 screening cycles have completed cleanly.

---

## Commands

| Task | Command |
|------|---------|
| Interactive REPL agent | `npm start` |
| Dev mode (force DRY_RUN) | `npm run dev` |
| Setup wizard | `npm run setup` |
| Run unit tests (vitest) | `npm test` (24 tests across `test/unit/`) |
| Watch tests during dev | `npm run test:watch` |
| Lint | `npm run lint` (eslint, flat config) |
| Syntax-check all `.js` files | `npm run test:syntax` |
| Screening unit test | `npm run test:screen` |
| Agent end-to-end test (dry-run) | `npm run test:agent` |
| Run a single test file | `node test/<file>.js` (e.g. `DRY_RUN=true node test/test-agent.js`) |
| CLI invocations | `node cli.js <subcommand>` (e.g. `evolve`, `lessons add "..."`, `positions`, `deploy --pool <addr> --amount 0.5`) |
| Daemonize with PM2 | `npm run pm2:start` → `pm2 save` → `pm2 startup` |
| Restart PM2 (after config edit) | `npm run pm2:restart` |
| Tail PM2 logs | `npm run pm2:logs` |
| Install as global `meridian` cmd | `npm install -g .` |

ESLint config: `eslint.config.js` (minimal — catches unused vars, undef refs, dupes, unreachable code; tolerates ~18 baseline warnings on legacy unused imports). `npm run typecheck` is intentionally not exposed yet — `tsconfig.json` is in place but a full `tsc --checkJs` pass requires a JSDoc-annotation effort across legacy modules, scheduled as a follow-up.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
  rate-limit.js     Deploy rate-limit sliding window (separated for testability)

server.js           Optional HTTP dashboard server (gated by DASHBOARD_ENABLED)
public/             Static frontend (index.html + dashboard.css + dashboard.js)
test/unit/          Vitest unit tests (config validation, dry-run, rate-limit, etc.)
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlePct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| repeatDeployCooldownBypassWhenIdle | management | false (true ⇒ at 0 open positions, ignore ONLY the "repeat fee-generating" cooldown). NB: risk cooldowns (OOR / low-yield) take precedence over the success cooldown and are never erased/shortened by it (`pool-memory.js resolveCooldownWrite`), so a token that also has an active OOR cooldown stays benched. |
| whaleDumpGuardEnabled | management | **true** (30s poller closes on dump signature: crash+vol-spike+whale-concentration; `/setcfg whaleDumpGuardEnabled false` to disable) |
| volBandEnabled / volBandThreshold / volBandHighStrategy / volBandMaxDeploySol | strategy | false / 3 / "bid_ask" / 0.5 — deterministic LP-shape selector: when enabled, pools with volatility ≥ threshold deploy as the high strategy; else base. Overridden (experimental) deploys are size-clamped to volBandMaxDeploySol SOL (≤0 disables clamp). Default off = no change. `strategy-selector.js` |
| whaleDumpPriceDropPct / whaleVolumeSpikePct / whaleMinAvgTradeUsd / whaleDumpMinPositionAgeMin | management | 12 / 150 / 3000 / 5 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| briefingHour | schedule | 7 (0–23, in briefingTimezone) |
| briefingTimezone | schedule | "Asia/Jakarta" |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- `volatility` must be a positive finite number when provided; fresh pool detail with volatility 0/null is rejected
- Total range must be at least `max(35, minBinsBelow)` bins; 1-bin/tiny deploys are refused
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- `amount_x > 0` is rejected. Deploys are single-side SOL only (`amount_y` / `amount_sol`)
- SOL balance must cover `amount_y + gasReserve`
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

Linear formula based on positive pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow)), clamped to [minBinsBelow, maxBinsBelow]
```

- Default clamp is `[35, 69]`
- `volatility <= 0`, null, or non-finite → skip/refuse deploy
- High volatility (5+) → maxBinsBelow
- Any value in between is valid (continuous, not tiered)

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |
| `/optimize` | Spawn headless `claude -p` to run the optimize-meridian skill in report-only mode; posts summary + tap-to-apply inline buttons. Apply path reuses `executeTool("update_config", …)` (same as `/setcfg`); validated in `optimize-apply.js` (allowlist + ≤30% magnitude + sign/range). No auto-edit, no self-restart. |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlePct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha` (config.js:144–146, agent.js:102)
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (agent.js:191) — **OpenRouter-only**. When pointed at any other provider (opencode.ai, LM Studio, etc.), the fallback request will fail and the retry attempt is effectively wasted.
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json — must use slugs the configured `llmBaseUrl` understands (e.g. `kimi-k2.6` for opencode.ai Zen Go, `openrouter/...` for OpenRouter, raw model name for LM Studio).
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- opencode.ai Zen Go: set `LLM_BASE_URL=https://opencode.ai/zen/go/v1` and `LLM_API_KEY=<zen go key>`. **No prefix** on slugs — bare ID only (verify with `curl -H "Authorization: Bearer $LLM_API_KEY" $LLM_BASE_URL/models`).
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- **Behavior**: `evolveThresholds()` (`lessons.js:317-411`) adjusts `minFeeActiveTvlRatio` and `minOrganic` from winner/loser stats, max 20% per 5-close cycle (`MAX_CHANGE_PER_STEP=0.20`), clamped to `[0.05, 10.0]` and `[60, 90]` respectively. **Limitation**: it only ever *raises* these floors, never lowers them — intentional, since loosening is delegated to the human-in-loop `/optimize-meridian` skill (both keys are in that skill's auto-edit allowlist). (An earlier key-name mismatch with `maxVolatility`/`minFeeTvlRatio` has been fixed.)

---

## HiveMind

Agent Meridian HiveMind sync is handled by `hivemind.js`. It uses built-in Agent Meridian defaults unless overridden by config or env.

If `hiveMindApiKey` is blank but `agentMeridianApiUrl` is set (the default), three `[HIVEMIND_WARN] Invalid HiveMind API key` warnings print every screening cycle (preset pull, lesson pull, agent register). The agent continues normally — these are cosmetic. To silence: set `agentMeridianApiUrl` to `""` in user-config.json, or obtain a key.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes* | LLM API key (*not required if using `LLM_BASE_URL` + `LLM_API_KEY` for a non-OpenRouter provider) |
| `LLM_API_KEY` | Yes* | API key when `LLM_BASE_URL` points to a non-OpenRouter provider |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `TELEGRAM_ALLOWED_USER_IDS` | No | Comma-separated user IDs allowed to issue `/close` etc. — without this, anyone can hijack the bot |
| `LLM_BASE_URL` | No | Override LLM endpoint (LM Studio, opencode.ai, etc.) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Boot Validation

`config.js` exposes `validateBoot({ env, userConfig, modelConfig })` which is called from `index.js` at startup. It refuses to start the agent if:
- `WALLET_PRIVATE_KEY` is missing or doesn't decode to a 64-byte Solana secret key (base58 or JSON array)
- `RPC_URL` is missing, not a valid URL, or not HTTPS (override via `user-config.json:rpcUrlMustBeHttps = false`)
- `LLM_API_KEY` and `OPENROUTER_API_KEY` are both missing
- Any per-role model slug (`screeningModel`, `managementModel`, `generalModel`) is empty
- `DRY_RUN` env contradicts `user-config.json:dryRun`

On failure: prints a bullet list of errors and exits 1. The agent will never silently boot misconfigured.

---

## Safety Controls

Added in the P1 hardening pass (see `docs/SAFETY.md` for the operator-facing version):

- **Atomic state writes** — `state.js save()` writes to `.tmp` + fsync + rename. Survives SIGKILL mid-write.
- **Crash handlers** — `index.js` registers `unhandledRejection` + `uncaughtException` logging.
- **Per-role model startup log** — `index.js` logs `screening / management / general` models so debugging is unambiguous.
- **Deploy rate caps** — `tools/rate-limit.js` exports `getDeployRateState()` + `recordDeployForRateLimit()`. Hourly + daily sliding window. Enforced in `tools/executor.js runSafetyChecks` before `deploy_position`. Defaults: 6/h, 20/day.
- **Emergency stop** — `config.risk.emergencyStop`. Flip via CLI (`config set emergencyStop true`), Telegram (`/emergency-stop` and `/resume`), or dashboard POST (`/api/emergency-stop`).
- **Position ID autocorrect** — `tools/dlmm.js resolvePositionAddress()` autocorrects 1–2 base58 char swaps via Levenshtein matching against the open-positions cache. Applied to `claimFees`, `closePosition`, `getPositionPnl`, `set_position_note`.
- **Provider-aware LLM fallback** — `agent.js` only attempts the `stepfun/step-3.5-flash:free` fallback when `LLM_BASE_URL` is OpenRouter-shaped. Other providers skip the wasted retry.
- **Telegram authorization visibility** — `telegram.js` posts a one-time visible warning when the allowlist rejects a command. Per-user denial replies (once per user).

---

## Dashboard

Optional read-only HTTP UI. Disabled by default. See README "Dashboard" section.

- `server.js` — express server, mounts only when `DASHBOARD_ENABLED=true`. Refuses to start if `DASHBOARD_PASSWORD` is unset (would expose `/api/emergency-stop` unauthenticated).
- Binds `127.0.0.1:3000` by default. Override with `DASHBOARD_HOST` / `DASHBOARD_PORT`.
- Static frontend in `public/` (HTML + CSS + vanilla JS + chart.js via CDN). No build step.
- Endpoints: `GET /api/{status,wallet,positions,performance,candidates,activity,config}` + `POST /api/{emergency-stop,resume}` (Basic Auth).
- Auto-refreshes every 10s in the browser.
- Times and P&L stats render in the viewer's **browser-local** timezone. `/api/performance` returns raw `points: [{t, pnl_usd}]`; daily/weekly/cumulative bucketing is done client-side in `public/dashboard.js` (`bucketPerf` / `localDayKey` / `localIsoWeekKey`) — never UTC-bucketed server-side.

---

## Known Issues / Tech Debt

- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
- `npm run typecheck` not exposed yet — `tsconfig.json` exists but full `tsc --checkJs` against legacy JS modules requires a JSDoc-annotation pass per module.
