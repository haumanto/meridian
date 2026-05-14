// Atomic state.json writes: when fs.renameSync fails (e.g. disk full,
// filesystem error), the original state.json must remain unchanged.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

describe("atomic state.json writes", () => {
  let tmpdir;
  let originalCwd;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-state-"));
    originalCwd = process.cwd();
    process.chdir(tmpdir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it("temp file is renamed atomically and state.json contains the new content", async () => {
    const { trackPosition } = await import("../../state.js");

    // First write: positions = { A: ... }
    trackPosition({
      position: "POS_A",
      pool: "POOL_A",
      pool_name: "TEST-SOL",
      strategy: "spot",
      bin_range: { min: -135, max: -100, bins_below: 35, bins_above: 0 },
      amount_sol: 1,
      amount_x: 0,
      active_bin: -100,
      bin_step: 80,
      volatility: 1.0,
      fee_tvl_ratio: 0.04,
      organic_score: 70,
      initial_value_usd: 100,
      signal_snapshot: null,
    });

    const stateFile = path.join(tmpdir, "state.json");
    expect(fs.existsSync(stateFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(data.positions.POS_A).toBeDefined();

    // The temp file pattern should not remain after a successful rename
    const tmpFiles = fs.readdirSync(tmpdir).filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });
});
