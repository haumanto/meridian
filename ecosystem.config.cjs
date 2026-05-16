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
      // The wallet key is injected at start time as a distinct env var
      // (never in .env, never committed):
      //   AUTORESEARCH_WALLET_PRIVATE_KEY=... pm2 start ecosystem.config.cjs \
      //     --only meridian-autoresearch --update-env
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
