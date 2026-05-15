// Cooldown "time left" accessors + formatter. getPoolCooldown /
// getBaseMintCooldown read ./pool-memory.json (cwd-relative), so the
// suite chdir's to a tmpdir with a fixture — same pattern as
// state-atomic.test.js.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

describe("pool/token cooldown time-left", () => {
  let tmpdir, originalCwd, mod;

  const future = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  const past = (mins) => new Date(Date.now() - mins * 60000).toISOString();

  beforeEach(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-cd-"));
    originalCwd = process.cwd();
    process.chdir(tmpdir);
    mod = await import("../../pool-memory.js");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  const writeDb = (db) => fs.writeFileSync(path.join(tmpdir, "pool-memory.json"), JSON.stringify(db));

  it("formatCooldownLeft renders compact durations", () => {
    const f = mod.formatCooldownLeft;
    expect(f(30 * 1000)).toBe("<1m");
    expect(f(47 * 60000)).toBe("47m");
    expect(f((4 * 60 + 12) * 60000)).toBe("4h 12m");
    expect(f((2 * 1440 + 3 * 60) * 60000)).toBe("2d 3h");
    expect(f(-5000)).toBe("<1m");
  });

  it("getPoolCooldown returns until/reason/left when active", () => {
    const until = future(252);
    writeDb({ POOL_A: { name: "X-SOL", cooldown_until: until, cooldown_reason: "repeated OOR closes (3x)" } });
    const cd = mod.getPoolCooldown("POOL_A");
    expect(cd).toBeTruthy();
    expect(cd.reason).toBe("repeated OOR closes (3x)");
    expect(cd.until).toBe(until);
    // ~252m out; sub-minute floor drift makes the exact minute nondeterministic,
    // so assert shape (the formatter itself is exhaustively unit-tested above).
    expect(cd.left).toMatch(/^4h \d{1,2}m$/);
  });

  it("getPoolCooldown returns null when expired or absent", () => {
    writeDb({ POOL_A: { cooldown_until: past(10), cooldown_reason: "low yield" }, POOL_B: {} });
    expect(mod.getPoolCooldown("POOL_A")).toBeNull(); // expired
    expect(mod.getPoolCooldown("POOL_B")).toBeNull(); // no cooldown field
    expect(mod.getPoolCooldown("MISSING")).toBeNull();
    expect(mod.getPoolCooldown(null)).toBeNull();
  });

  it("getBaseMintCooldown picks the latest active expiry across a token's pools", () => {
    writeDb({
      P1: { base_mint: "MINT1", base_mint_cooldown_until: future(60), base_mint_cooldown_reason: "repeat fee-generating deploys (3x)" },
      P2: { base_mint: "MINT1", base_mint_cooldown_until: future(300), base_mint_cooldown_reason: "repeat fee-generating deploys (3x)" },
      P3: { base_mint: "OTHER", base_mint_cooldown_until: future(999) },
    });
    const cd = mod.getBaseMintCooldown("MINT1");
    expect(cd).toBeTruthy();
    // Proves it picked the LATER expiry (P2 @ ~300m, not P1 @ ~60m).
    expect(cd.left).toMatch(/^4h \d{1,2}m$|^5h 0m$/);
    expect(cd.reason).toBe("repeat fee-generating deploys (3x)");
    expect(mod.getBaseMintCooldown("UNKNOWN")).toBeNull();
    expect(mod.getBaseMintCooldown(null)).toBeNull();
  });

  it("getBaseMintCooldown returns null when all matching cooldowns expired", () => {
    writeDb({ P1: { base_mint: "MINT1", base_mint_cooldown_until: past(5) } });
    expect(mod.getBaseMintCooldown("MINT1")).toBeNull();
  });
});
