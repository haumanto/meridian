// Central path resolver. Pure: NO fs/IO at import time.
//
// Default (no env): dataDir === __root (the repo root). Because the live
// PM2 app runs with cwd === repo root, every path below resolves to the
// EXACT same absolute location the agent used before this module existed
// (the legacy "./X.json" and path.join(__dirname,"X.json") forms both
// resolve there) — a pure indirection, zero behavior change for main.
//
// Profile isolation: set MERIDIAN_DATA_DIR (resolved relative to __root)
// to redirect ALL persisted state/logs into an isolated subtree, and
// optionally MERIDIAN_CONFIG_PATH to point user-config.json elsewhere.
import path from "path";
import { fileURLToPath } from "url";

const __root = path.dirname(fileURLToPath(import.meta.url));

const dataDir = process.env.MERIDIAN_DATA_DIR
  ? path.resolve(__root, process.env.MERIDIAN_DATA_DIR)
  : __root;

const userConfigPath = process.env.MERIDIAN_CONFIG_PATH
  ? path.resolve(__root, process.env.MERIDIAN_CONFIG_PATH)
  : path.join(dataDir, "user-config.json");

export const paths = {
  root: __root,
  dataDir,
  userConfigPath,
  statePath:           path.join(dataDir, "state.json"),
  lessonsPath:         path.join(dataDir, "lessons.json"),
  poolMemoryPath:      path.join(dataDir, "pool-memory.json"),
  decisionLogPath:     path.join(dataDir, "decision-log.json"),
  signalWeightsPath:   path.join(dataDir, "signal-weights.json"),
  strategyLibraryPath: path.join(dataDir, "strategy-library.json"),
  tokenBlacklistPath:  path.join(dataDir, "token-blacklist.json"),
  devBlocklistPath:    path.join(dataDir, "dev-blocklist.json"),
  smartWalletsPath:    path.join(dataDir, "smart-wallets.json"),
  hivemindCachePath:   path.join(dataDir, "hivemind-cache.json"),
  telegramOffsetPath:  path.join(dataDir, "telegram-offset.json"),
  logDir:              path.join(dataDir, "logs"),
};
