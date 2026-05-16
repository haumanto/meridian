// paths.js is the keystone of profile isolation. The contract:
//  (1) no env  → every path === <repo root>/<file> (byte-identical to
//      the pre-refactor hardcoded locations — main agent zero-regression)
//  (2) MERIDIAN_DATA_DIR set → everything redirected under that subtree
//  (3) MERIDIAN_CONFIG_PATH independent of dataDir
// paths.js reads env at import, so each case needs a fresh module.

import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";

// vitest runs from the repo root — the same dir paths.js resolves as
// its __root, so this is the byte-identity oracle.
const ROOT = process.cwd();

async function freshPaths() {
  vi.resetModules();
  return (await import("../../paths.js")).paths;
}

describe("paths.js resolver", () => {
  afterEach(() => {
    delete process.env.MERIDIAN_DATA_DIR;
    delete process.env.MERIDIAN_CONFIG_PATH;
    vi.resetModules();
  });

  it("default (no env): every path is byte-identical to <root>/<file>", async () => {
    delete process.env.MERIDIAN_DATA_DIR;
    delete process.env.MERIDIAN_CONFIG_PATH;
    const p = await freshPaths();
    expect(p.root).toBe(ROOT);
    expect(p.dataDir).toBe(ROOT);
    expect(p.statePath).toBe(path.join(ROOT, "state.json"));
    expect(p.lessonsPath).toBe(path.join(ROOT, "lessons.json"));
    expect(p.poolMemoryPath).toBe(path.join(ROOT, "pool-memory.json"));
    expect(p.decisionLogPath).toBe(path.join(ROOT, "decision-log.json"));
    expect(p.signalWeightsPath).toBe(path.join(ROOT, "signal-weights.json"));
    expect(p.strategyLibraryPath).toBe(path.join(ROOT, "strategy-library.json"));
    expect(p.tokenBlacklistPath).toBe(path.join(ROOT, "token-blacklist.json"));
    expect(p.devBlocklistPath).toBe(path.join(ROOT, "dev-blocklist.json"));
    expect(p.smartWalletsPath).toBe(path.join(ROOT, "smart-wallets.json"));
    expect(p.hivemindCachePath).toBe(path.join(ROOT, "hivemind-cache.json"));
    expect(p.telegramOffsetPath).toBe(path.join(ROOT, "telegram-offset.json"));
    expect(p.userConfigPath).toBe(path.join(ROOT, "user-config.json"));
    expect(p.logDir).toBe(path.join(ROOT, "logs"));
  });

  it("MERIDIAN_DATA_DIR (relative) redirects ALL artifacts under it", async () => {
    process.env.MERIDIAN_DATA_DIR = "profiles/autoresearch";
    const p = await freshPaths();
    const d = path.join(ROOT, "profiles", "autoresearch");
    expect(p.dataDir).toBe(d);
    expect(p.statePath).toBe(path.join(d, "state.json"));
    expect(p.lessonsPath).toBe(path.join(d, "lessons.json"));
    expect(p.poolMemoryPath).toBe(path.join(d, "pool-memory.json"));
    expect(p.logDir).toBe(path.join(d, "logs"));
    expect(p.userConfigPath).toBe(path.join(d, "user-config.json"));
    expect(p.root).toBe(ROOT); // root is fixed regardless
  });

  it("MERIDIAN_DATA_DIR absolute path is honored as-is", async () => {
    process.env.MERIDIAN_DATA_DIR = "/tmp/meridian-abs-xyz";
    const p = await freshPaths();
    expect(p.dataDir).toBe("/tmp/meridian-abs-xyz");
    expect(p.statePath).toBe("/tmp/meridian-abs-xyz/state.json");
  });

  it("MERIDIAN_CONFIG_PATH overrides user-config independently of dataDir", async () => {
    process.env.MERIDIAN_DATA_DIR = "profiles/autoresearch";
    process.env.MERIDIAN_CONFIG_PATH = "custom/my-config.json";
    const p = await freshPaths();
    expect(p.userConfigPath).toBe(path.join(ROOT, "custom", "my-config.json"));
    // state still follows dataDir, not the config override
    expect(p.statePath).toBe(path.join(ROOT, "profiles", "autoresearch", "state.json"));
  });
});
