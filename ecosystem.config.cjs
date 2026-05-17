module.exports = {
  apps: [
    {
      name: "meridian",
      script: "index.js",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      // Isolated autoresearch instance. Runs alongside `meridian` on a
      // SEPARATE wallet + isolated data dir (profiles/autoresearch/*).
      // Secrets are injected at start time as distinct env vars (never
      // in .env, never committed). The wallet key is required; the
      // dedicated-bot vars are optional — set them to give AR its OWN
      // Telegram bot (separate token + chat) with full inbound control,
      // fully isolated from main (no getUpdates contention). Omit them
      // and AR stays Telegram-silent (reports via results.jsonl + logs):
      //   AUTORESEARCH_WALLET_PRIVATE_KEY=... \
      //   AUTORESEARCH_TELEGRAM_BOT_TOKEN=... \
      //   AUTORESEARCH_TELEGRAM_CHAT_ID=... \
      //   AUTORESEARCH_TELEGRAM_ALLOWED_USER_IDS=... \
      //   pm2 start ecosystem.config.cjs --only meridian-autoresearch --update-env
      // Boot is hard-gated by runAutoresearchStartupGuard() in index.js
      // (aborts if data dir == root, key missing, key == prod wallet, or
      // capital caps unset). cwd stays repo root so envcrypt still finds
      // the shared .env for RPC/LLM/Helius (NOT the wallet key).
      name: "meridian-autoresearch",
      script: "index.js",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
        MERIDIAN_PROFILE: "autoresearch",
        MERIDIAN_DATA_DIR: "profiles/autoresearch",
        MERIDIAN_RESEARCH_RUN_ID: "run-001",
      },
    },
  ],
};
