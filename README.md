# Meridian

**Autonomous Meteora DLMM liquidity-management agent for Solana, powered by LLMs.**

**Links:** [Website](https://agentmeridian.xyz) · [Telegram](https://t.me/agentmeridian) · [X](https://x.com/meridian_agent)

Meridian runs continuous screening and management cycles: it scans Meteora DLMM pools, deploys capital into high-quality ones, manages and closes positions on live PnL/yield/range data, and learns from every close.

---

## Contents

- [What it is](#what-it-is)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Running modes](#running-modes)
- [Operating the agent](#operating-the-agent) — [Telegram](#telegram) · [Tuning & learning](#tuning--learning) · [Dashboard](#dashboard)
- [Reliability & safety](#reliability--safety) — [Multi-provider RPC](#multi-provider-rpc) · [LLM fallback](#llm-fallback) · [Safety controls](#safety-controls)
- [Config reference](#config-reference)
- [Integrations](#integrations) — [Discord](#discord-listener) · [HiveMind](#hivemind)
- [Architecture](#architecture)
- [Disclaimer](#disclaimer)

---

## What it is

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds (fee/TVL, organic score, holders, mcap, bin step, bundler/concentration) and ranks the best candidates.
- **Manages positions** — monitors PnL/yield/range, claims fees, and closes on stop-loss, take-profit, trailing TP, out-of-range timeout, or low yield — deterministically, with the LLM executing rather than re-deciding hard exits.
- **Learns** — records every closed position, derives lessons, and evolves screening thresholds from realized performance.
- **Resilient infra** — multi-provider RPC (public reads / keyed sends) and per-role + cross-provider LLM fallback so a single upstream outage doesn't stop trading.
- **Operate it your way** — fully autonomous (PM2), a built-in REPL, Telegram chat + control, or Claude Code slash commands.

---

## Quick start

```bash
git clone https://github.com/haumanto/meridian
cd meridian
npm install
npm run setup          # interactive: writes .env + user-config.json (~2 min)
```

Keep `DRY_RUN=true` (in `.env`) and `"dryRun": true` (in `user-config.json`) until you've watched a few clean cycles.

```bash
npm run dev            # dry run — no on-chain transactions
```

When you're satisfied, set `DRY_RUN=false` + `"dryRun": false`, then run live under PM2:

```bash
npm run pm2:start && pm2 save
```

> **Secrets go in `.env` only** (wallet key, API keys, RPC keys). Never in `user-config.json`. Both are gitignored. Requirements: Node.js ≥ 18 (22 recommended), a Solana wallet (base58 key), a Solana RPC endpoint, an LLM API key (OpenRouter or any OpenAI-compatible provider). Telegram + Claude Code are optional.

### Manual setup (instead of the wizard)

`.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
HELIUS_API_KEY=your_helius_key            # wallet-balance lookups (Helius-specific REST)
TELEGRAM_BOT_TOKEN=123456:ABC...          # optional
TELEGRAM_CHAT_ID=                         # required for Telegram control (see Telegram)
TELEGRAM_ALLOWED_USER_IDS=                # comma-separated; required for group control
DRY_RUN=true
```

```bash
cp user-config.example.json user-config.json   # then edit — see Config reference
```

Optional encrypted `.env` (values decrypt automatically at boot):

```bash
cp .env .env.raw
printf "a-long-local-key\n" > .envrypt
npm run env:encrypt
```

---

## How it works

A **ReAct loop**: each cycle the LLM reasons over live state, calls tools, and acts. Two agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Screening** | every 30 min (`screeningIntervalMin`) | Find and deploy into the best candidate |
| **Management** | every 10 min (`managementIntervalMin`) | Evaluate every open position; STAY / CLOSE / CLAIM |

The screening cycle **skips itself entirely when the per-hour or per-day deploy cap is already saturated** — no wasted LLM calls or RPC when no deploy is possible.

Every deploy/close/skip/no-deploy is written to `decision-log.json` (actor, pool/position, summary, reason, risks, metrics, rejected alternatives) and fed back into the prompt, so the agent can answer "why did you deploy/close/skip?" from record, not guesswork.

**Data sources:** `@meteora-ag/dlmm` SDK (on-chain positions, deploy/close txs) · Meteora DLMM PnL API · OKX OnchainOS (smart-money + risk) · pool screening API · Jupiter (token audit, mcap, price).

LLMs are reached via any OpenAI-compatible endpoint (OpenRouter, opencode.ai Zen Go, LM Studio, …).

---

## Running modes

### Autonomous (recommended — PM2)

```bash
npm run pm2:start && pm2 save        # start + persist across reboots
npm run pm2:restart                  # after a config/code change
npm run pm2:logs                     # tail logs
```

Update flow: `git pull && npm install && npm run pm2:restart`. If it restart-loops after an update, check `npm run pm2:logs` first — usually a skipped `npm install`, wrong cwd, or missing `.env`/`user-config.json`. Avoid `nohup` (it escapes PM2 and can duplicate Telegram polling).

`npm start` runs the same agent with an interactive REPL and a live countdown prompt `[manage: 8m | screen: 24m] >`. REPL commands:

| Command | Description |
|---|---|
| `/status` | Wallet balance + open positions |
| `/candidates` | Re-screen and show top candidates |
| `/learn [pool]` | Study top LPers (all candidates, or one pool) |
| `/thresholds` | Screening thresholds + performance stats |
| `/evolve` | Evolve thresholds from performance (needs 5+ closes) |
| `/stop` | Graceful shutdown |
| *anything else* | Free-form chat — ask, analyze, request actions |

### Claude Code

From the repo dir run `claude`. Ships slash commands `/screen` `/manage` `/balance` `/positions` `/candidates` `/study-pool` `/pool-ohlcv` `/pool-compare`, and two sub-agents (`screener`, `manager`). Loop them on a timer: `/loop 30m /screen`, `/loop 10m /manage`. (`/optimize-meridian` is a separate operator-installed skill — see [Tuning & learning](#tuning--learning).)

### `meridian` CLI

Direct tool access with JSON output — scripting/debugging.

```bash
npm install -g .            # once (or use: node cli.js <cmd>)
meridian positions | pnl <addr> | wallet-positions --wallet <addr>
meridian candidates --limit 5 | pool-detail --pool <addr> | active-bin --pool <addr>
meridian search-pools --query <name> | study --pool <addr>
meridian token-info --query <mint> | token-holders --mint <addr> | token-narrative --mint <addr>
meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--strategy bid_ask|spot|curve] [--dry-run]
meridian claim --position <addr> | close --position <addr> [--skip-swap] | swap --from <m> --to <m> --amount <n>
meridian screen [--dry-run] [--silent] | manage [--dry-run] [--silent] | start [--dry-run]
meridian config get | config set <key> <value>
meridian lessons [add "text"] | performance [--limit 200] | evolve | pool-memory --pool <addr>
meridian blacklist list | add --mint <addr> --reason "..."
meridian balance | discord-signals [clear]
```

| Flag | Effect |
|---|---|
| `--dry-run` | Skip all on-chain transactions |
| `--silent` | Suppress Telegram notifications for this run |

---

## Operating the agent

### Telegram

**Setup (explicit — there is no chat auto-registration, by design, for safety):**

1. Create a bot via [@BotFather](https://t.me/BotFather), copy the token.
2. In `.env` set:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<target chat id>
TELEGRAM_ALLOWED_USER_IDS=<comma-separated user ids allowed to control the bot>
```

- If `TELEGRAM_CHAT_ID` is unset, **inbound control is ignored** (notifications still send once a chat is configured).
- In a group/supergroup with empty `TELEGRAM_ALLOWED_USER_IDS`, inbound control is ignored.
- Unauthorized users get one explicit denial reply (not silent).

**Commands** (auto-registered into Telegram's native `/` menu at startup — type `/` in the chat):

| Command | Action |
|---|---|
| `/help` | Command list |
| `/wallet`, `/status` | Wallet balance + open positions |
| `/positions` | Open positions with progress bars |
| `/pool <n>` | Details for candidate/position *n* |
| `/close <n>` | Close position *n* |
| `/closeall` | Close every open position |
| `/set <n> <note>` | Set a note on position *n* |
| `/config`, `/settings`, `/menu` | Settings menu |
| `/setcfg <key> <value>` | Set a config key live |
| `/briefing` | Daily briefing |
| `/screen` | Trigger a screening cycle |
| `/candidates` | Show current candidates |
| `/deploy <n>` | Deploy into candidate *n* |
| `/pause` | Pause autonomous cycles |
| `/emergency-stop` | Hard-stop all deploys |
| `/resume` | Clear emergency stop |
| `/hive [pull]` | HiveMind status / manual pull |

Allowed users can also chat free-form (`"close all positions"`, `"who are the top LPers in pool ABC"`, …).

**Notifications:** management cycle reports · screening cycle reports · OOR alerts past `outOfRangeWaitMinutes` · deploy (pair, amount, position, tx) · **close (pair, PnL, and a `Why:` line — the exact recorded close reason, e.g. `Trailing TP: peak 6.55% → -1.30%`)** · the `/optimize-meridian` nudge (below).

### Tuning & learning

- **Lessons** — every close derives a lesson, injected into later prompts. Add manually: `node cli.js lessons add "Never deploy pump.fun tokens under 2h old"`.
- **Threshold evolution** — after 5+ closes, `node cli.js evolve` adjusts screening thresholds in `user-config.json` from realized win-rate / PnL / fee yield (only ever *raises* `minOrganic` / `minFeeActiveTvlRatio`; loosening is left to the operator workflow below). Darwin signal-weighting (`darwinEnabled`) reweights signals once enough closes accrue.
- **`/optimize-meridian`** *(Claude Code operator skill, run from the repo dir)* — analyzes accumulated closes/pool-memory/errors and **auto-edits screening thresholds within a strict allowlist**, then writes a markdown report to `optimization-reports/`. Risk/sizing/exit/model knobs are **recommendation-only** (never auto-applied). It fails closed on gates (active drawdown, <3-day history, low sample). The agent sends a Telegram nudge every `optimizeNudgeEveryCloses` (default 10) closes since the last run.

### Dashboard

Optional read-only web UI, localhost-only, disabled by default.

```env
DASHBOARD_ENABLED=true
DASHBOARD_PASSWORD=pick-a-strong-password   # required, else it refuses to start
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=3000
```

Tabs: Overview · Positions · Screening · Activity · Settings (sanitized — model IDs/thresholds/booleans only, no secrets). Read GETs are open on localhost; `POST /api/emergency-stop` / `/api/resume` need HTTP Basic Auth with `DASHBOARD_PASSWORD`. Auto-refreshes every 10s.

---

## Reliability & safety

### Multi-provider RPC

Two tiers, ordered failover, no websockets (request-level, stateless):

- **Keyed tier** — `.env: RPC_URLS` (comma-separated, secret) or single `RPC_URL`. Reliable/paid endpoints. Used for **all transaction sends** and as the read fallback. The first entry is the send target — put your best tx-landing endpoint first.
- **Public tier** — `user-config.json: rpcUrlsPublic` (or `.env: RPC_URLS_PUBLIC`, not secret). Keyless endpoints tried **first for idempotent reads** to save paid-RPC credits; on a transient error (timeout/5xx/429) reads fall over to the keyed tier. Sends never use the public tier.

Single `RPC_URL` with no public tier behaves exactly as before (backward compatible). Each provider's API key is embedded in its URL — no separate key field.

### LLM fallback

Per role (screening / management / general), an ordered candidate chain:

1. **Primary** model (`screeningModel` / `managementModel` / `generalModel`).
2. **Same-provider siblings** — `screeningFallbackModels` / `managementFallbackModels` / `generalFallbackModels` (arrays in `user-config.json`): tried on a model/upstream error (HTTP 5xx) while the provider is still reachable.
3. **Alternative provider** — `.env: LLM_ALT_BASE_URL` / `LLM_ALT_API_KEY` / `LLM_ALT_MODEL` (+ optional per-role `LLM_ALT_<ROLE>_MODEL`): used when the primary provider is fully unreachable (connection-level failure). All three required together or it stays inactive.

Rate-limit (429) still uses the existing wait-and-retry. No fallback configured ⇒ single-candidate chain ⇒ unchanged behavior.

### Safety controls

| Control | Where | Default | Effect |
|---|---|---|---|
| **Boot validation** | `config.js validateBoot()` | always | Refuses to start on bad wallet key, invalid/non-https RPC, missing LLM key, empty model slug, partial `LLM_ALT_*`, or `DRY_RUN`↔`dryRun` mismatch. Exits 1 with a bullet list. |
| **DRY_RUN** | `.env` + `user-config.json:dryRun` | true | Either true ⇒ every write tool returns a `{ dry_run: true }` sentinel instead of signing. |
| **Emergency stop** | `user-config.json:emergencyStop` | false | When true, `deploy_position` refuses. Toggle via CLI, Telegram `/emergency-stop` / `/resume`, or dashboard. Persists across restarts. |
| **Deploy caps** | `maxDeploysPerHour` / `maxDeploysPerDay` | 6 / 20 | Sliding window **persisted to `state.json` (`deploy_rate.timestamps`)** — survives PM2 restarts (a restart no longer silently resets the cap). Screening cycle skips itself while saturated. |
| **maxPositions** | `user-config.json` | 3 | Hard ceiling on concurrent positions; force-fresh count before each deploy. |
| **Position-ID autocorrect** | `tools/dlmm.js` | always | Fixes 1–2 transposed base58 chars in tool-call addresses; refuses when ambiguous. |
| **Atomic state writes** | `state.js` | always | `.tmp` + `fsync` + `rename`; a kill mid-write can't corrupt tracking. |
| **Crash handlers** | `index.js` | always | `unhandledRejection`/`uncaughtException` logged; PM2 restarts cleanly. |
| **Telegram allowlist** | `.env:TELEGRAM_ALLOWED_USER_IDS` | empty | Non-allowlisted users are rejected with one explicit reply. |
| **Dashboard auth** | `.env:DASHBOARD_PASSWORD` | unset | Required to enable the dashboard; gates the mutating endpoints. |

---

## Config reference

Edit `user-config.json` (overrides) — values below are the **`config.js` defaults**. Secrets stay in `.env`.

### Screening

| Field | Default | Meaning |
|---|---|---|
| `minFeeActiveTvlRatio` | `0.05` | Min fee / active-TVL ratio |
| `minTvl` / `maxTvl` | `10000` / `150000` | Pool TVL window (USD) |
| `minVolume` | `500` | Min pool volume |
| `minOrganic` / `minQuoteOrganic` | `60` / `60` | Min organic score (0–100) |
| `minHolders` | `500` | Min token holders |
| `minMcap` / `maxMcap` | `150000` / `10000000` | Market-cap window (USD) |
| `minBinStep` / `maxBinStep` | `80` / `125` | Bin-step window |
| `timeframe` / `category` | `5m` / `trending` | Screening candle / pool category |
| `minTokenFeesSol` | `30` | Min all-time fees (SOL) |
| `maxBundlePct` / `maxBotHoldersPct` | `30` / `30` | Max bundler / bot-holder % |
| `maxTop10Pct` | `60` | Max top-10 holder concentration |
| `blockedLaunchpads` | `[]` | Launchpads to never deploy into |

### Management & risk

| Field | Default | Meaning |
|---|---|---|
| `deployAmountSol` | `0.5` | Base SOL per position |
| `positionSizePct` | `0.35` | Fraction of deployable balance per position |
| `maxDeployAmount` | `50` | Hard SOL cap per position |
| `gasReserve` | `0.2` | SOL kept for gas |
| `minSolToOpen` | `0.55` | Min wallet SOL before opening |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR before acting |
| `stopLossPct` | `-50` | Hard stop-loss % |
| `takeProfitPct` | `5` | Take-profit % |
| `trailingTriggerPct` / `trailingDropPct` | `3` / `1.5` | Arm trailing at +%, exit on drop-from-peak % |
| `oorCooldownTriggerCount` / `oorCooldownHours` | `3` / `12` | Bench a pool after N OOR closes, for H hours |
| `repeatDeployCooldownEnabled` | `true` | Cool down repeatedly-farmed pools/tokens |
| `maxPositions` | `3` | Max concurrent positions |
| `maxDeploysPerHour` / `maxDeploysPerDay` | `6` / `20` | Deploy rate caps (persisted) |

### Schedule & models

| Field | Default | Meaning |
|---|---|---|
| `managementIntervalMin` | `10` | Management cadence (min) |
| `screeningIntervalMin` | `30` | Screening cadence (min) |
| `healthCheckIntervalMin` | `60` | Health-check cadence (min) |
| `optimizeNudgeEveryCloses` | `10` | Telegram nudge every N closes since last optimize (0 = off) |
| `managementModel` | `openrouter/healer-alpha` | Management LLM |
| `screeningModel` | `openrouter/hunter-alpha` | Screening LLM |
| `generalModel` | `openrouter/healer-alpha` | REPL/chat LLM |
| `fallbackModel` | `stepfun/step-3.5-flash:free` | Legacy OpenRouter-only fallback |
| `darwinEnabled` | `true` | Darwinian signal reweighting |

Per-role provider overrides also exist (`screeningBaseUrl`/`screeningApiKey`/`screeningTemperature`/`screeningMaxTokens`, same for management/general) plus the fallback keys in [LLM fallback](#llm-fallback). Override anything live: `node cli.js config set screeningModel <slug>`.

### Using a local model (LM Studio)

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works.

---

## Integrations

### Discord listener

Optional selfbot that watches channels (e.g. LP Army) for Solana token calls and queues them as priority screening signals.

```bash
cd discord-listener && npm install
```

Add to the root `.env`:

```env
DISCORD_USER_TOKEN=your_discord_account_token
DISCORD_GUILD_ID=server_id
DISCORD_CHANNEL_IDS=channel1,channel2
DISCORD_MIN_FEES_SOL=5
```

Run `npm start` in `discord-listener/`. Each address passes a pre-check pipeline — dedup (10 min) → token blacklist → resolve to a Meteora pool → deployer-blacklist (`deployer-blacklist.json`) → min-fees — then is queued `pending` and processed by the screener before its normal cycle. (Selfbot = personal-account automation; use responsibly.)

### HiveMind

Shared learning via Agent Meridian (`https://api.agentmeridian.xyz`, built-in public key — no registration needed; `agentId` auto-generated).

- **Pull:** shared lessons, strategy presets, crowd context (role-aware when `hiveMindPullMode: "auto"`).
- **Push:** lessons + closed-position events (pool, strategy, close reason, PnL, fees, hold time) + heartbeat. **Private keys and balances are never sent.**
- Failures are non-blocking. Set `hiveMindPullMode: "manual"` to stop auto-pull. Blank `hiveMindUrl`/`hiveMindApiKey` fall back to the shared defaults (there is no clear-to-disable path yet).

---

## Architecture

```
index.js            Entry: REPL + cron orchestration + Telegram polling
agent.js            ReAct loop; per-role + cross-provider LLM fallback chain
config.js           Runtime config (user-config.json + .env) + validateBoot
prompt.js           System-prompt builder (SCREENER / MANAGER / GENERAL)
state.js            Position registry + persisted deploy-rate counter (state.json)
lessons.js          Performance records, lesson derivation, threshold evolution
pool-memory.js      Per-pool deploy history, cooldowns, snapshots
strategy-library.js Saved LP strategies
telegram.js         Telegram polling + notifications
hivemind.js         Agent Meridian sync
smart-wallets.js    KOL/alpha wallet tracker
token-blacklist.js  Permanent token blacklist
briefing.js         Daily Telegram briefing
server.js           Optional read-only dashboard (gated)
logger.js           Daily-rotating logs + action audit trail
cli.js              Direct CLI — every tool as a JSON subcommand

tools/
  definitions.js    Tool schemas (OpenAI format)
  executor.js       Tool dispatch + safety checks
  dlmm.js           Meteora DLMM SDK wrapper
  screening.js      Pool discovery + ranking
  wallet.js         SOL/token balances + Jupiter swap
  token.js          Token info / holders / narrative
  study.js          Top-LPer study (LPAgent API)
  rate-limit.js     Deploy rate-limit sliding window (state-backed)
  rpc-provider.js   Multi-provider RPC (public reads / keyed sends)
  fetch-retry.js    HTTP retry/backoff wrapper

discord-listener/   Selfbot listener + pre-check pipeline
.claude/            Claude Code commands (screen, manage, …) + sub-agents
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice. The authors are not responsible for any losses incurred through use of this software.
