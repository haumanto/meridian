# Meridian — safety controls

A plain-English reference for the operator. If something looks off with the agent, this page is the first stop.

---

## You can stop the agent four ways

| Speed | How | Effect | Persists across restarts? |
|---|---|---|---|
| Instant — refuses next deploy | Telegram `/emergency-stop` | `config.risk.emergencyStop` flipped to true. Existing positions still managed normally; no new deploys. | **Yes** |
| Instant — same as above | Dashboard "🛑 Activate emergency stop" button (requires `DASHBOARD_PASSWORD`) | Same | **Yes** |
| Instant — same as above | `node cli.js config set emergencyStop true` | Same | **Yes** |
| Hard — daemon dies | `pm2 stop meridian` | Agent process stops. No notifications, no cycles, no management. | n/a |

To resume: Telegram `/resume`, dashboard "Clear emergency stop", or `node cli.js config set emergencyStop false`.

---

## What the agent refuses to do

| If… | …it does this |
|---|---|
| `WALLET_PRIVATE_KEY` is missing or malformed | Refuses to start. Prints a clear error and exits 1. |
| `RPC_URL` is not HTTPS | Refuses to start. Override with `rpcUrlMustBeHttps: false` in user-config.json (not recommended). |
| `LLM_API_KEY` and `OPENROUTER_API_KEY` are both missing | Refuses to start. |
| Any per-role model slug is empty | Refuses to start. |
| `DRY_RUN=true` in `.env` but `dryRun: false` in user-config.json (or vice versa) | Refuses to start. Reconcile and retry. |
| You've deployed 6 positions in the last hour (default) | Refuses the 7th. `maxDeploysPerHour` configurable. |
| You've deployed 20 positions in the last 24 hours (default) | Refuses the 21st. `maxDeploysPerDay` configurable. |
| You already have 3 concurrent positions (default) | Refuses to open a 4th. `maxPositions` configurable. |
| `emergencyStop: true` is in config | Refuses every `deploy_position` call with an explicit reason. |
| The LLM passes a position address that doesn't match any open position exactly | Autocorrects if there's exactly one match within edit-distance 2; refuses (loudly) if ambiguous or no match. |
| `DRY_RUN=true` is set | Every write tool (`deploy_position`, `close_position`, `claim_fees`, `swap_token`) returns a `{ dry_run: true }` sentinel instead of signing. |

---

## What the agent logs

- **Daily log** at `logs/agent-YYYY-MM-DD.log` — every cycle, error, decision summary.
- **Action audit** at `logs/actions-YYYY-MM-DD.jsonl` — every tool call with arguments, result, duration, success. Useful for replaying decisions.
- **Telegram notifications** — deploys, closes, claims, swaps, OOR alerts, errors.
- **Decision log** (`decision-log.json`) — structured deploy/close/skip records with rationale. Injected into next prompt.

Secrets are **never** logged. Wallet private key, API keys, and Telegram tokens are excluded by the logger.

---

## What the agent does NOT do

- **Multi-RPC failover.** If your RPC dies, the agent can't trade. Use a reliable provider (Helius recommended).
- **Hardware-wallet signing.** Keys live in `.env` on disk. `chmod 600 .env`. Treat the host as a secret-holding box.
- **Withdraw to a different wallet.** All swaps/claims/closes return to the wallet that opened them.
- **Trade outside of Meteora DLMM.** All deploys/closes are DLMM positions. Swaps via Jupiter.
- **Persistent rate counters across restarts.** The hourly/daily caps are in-memory. If PM2 restarts mid-flash, you get the budget back — by design, since a crash is signal that something's wrong.

---

## When to flip emergency stop

Good reasons:
- Market flash-crash or wash-volume event — the screener's scoring will lag
- You spotted a clearly bad deploy that's still pending close
- You're about to take the wallet offline for maintenance
- Telegram `/positions` shows a state you don't recognize and you want to pause until you investigate
- Your RPC provider is flapping

Bad reasons (use `/pause` instead, it's lighter):
- You just want to stop cron cycles for an hour
- You're tuning thresholds and don't want a deploy mid-edit

`/pause` stops the cron (volatile, lost on restart). `/emergency-stop` writes the flag to disk (survives restarts). Both can be combined.

---

## Recovering from a corrupted `state.json`

The agent uses atomic writes (write-tmp + fsync + rename) so this should be rare. If it happens anyway:

1. `pm2 stop meridian`
2. Backup: `cp state.json state.json.bad`
3. Look in `logs/` for the last good cycle and reconstruct from there, OR
4. Delete `state.json` — the agent will re-fetch open positions from chain on next boot. Lost: deploy timestamps, OOR start times, peak PnL, instruction notes (not recoverable).

---

## Reporting a security issue

The Github repo is public. Don't open a public issue for security-sensitive findings. Email or DM the maintainer directly.
