// Cooldown "time left" accessors + formatter. getPoolCooldown /
// getBaseMintCooldown read ./pool-memory.json (cwd-relative), so the
// suite chdir's to a tmpdir with a fixture — same pattern as
// state-atomic.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

describe("pool/token cooldown time-left", () => {
  let tmpdir, mod;

  const future = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  const past = (mins) => new Date(Date.now() - mins * 60000).toISOString();

  // Isolate via MERIDIAN_DATA_DIR + module reset so pool-memory.json
  // binds to the tmpdir, never the live file.
  beforeEach(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-cd-"));
    process.env.MERIDIAN_DATA_DIR = tmpdir;
    vi.resetModules();
    mod = await import("../../pool-memory.js");
  });

  afterEach(() => {
    delete process.env.MERIDIAN_DATA_DIR;
    vi.resetModules();
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

  // ── idle-capital bypass ──────────────────────────────────────────
  it("shouldBypassCooldown: only when enabled + zero positions + no risk + fee-gen reason", () => {
    const f = mod.shouldBypassCooldown;
    const FG = "repeat fee-generating deploys (3x)";
    // happy path
    expect(f({ enabled: true, openPositions: 0, poolReason: FG, mintHasRiskCooldown: false })).toBe(true);
    // pool-level cooldown absent (null reason) but mint fee-gen → still bypassable
    expect(f({ enabled: true, openPositions: 0, poolReason: null, mintHasRiskCooldown: false })).toBe(true);
    // flag off
    expect(f({ enabled: false, openPositions: 0, poolReason: FG, mintHasRiskCooldown: false })).toBe(false);
    // not idle
    expect(f({ enabled: true, openPositions: 1, poolReason: FG, mintHasRiskCooldown: false })).toBe(false);
    // a risk cooldown is also active on the mint
    expect(f({ enabled: true, openPositions: 0, poolReason: FG, mintHasRiskCooldown: true })).toBe(false);
    // pool cooldown reason is a RISK reason (OOR / low yield)
    expect(f({ enabled: true, openPositions: 0, poolReason: "repeated OOR closes (3x)", mintHasRiskCooldown: false })).toBe(false);
    expect(f({ enabled: true, openPositions: 0, poolReason: "low yield", mintHasRiskCooldown: false })).toBe(false);
    // openPositions must be exactly 0 (null/undefined from manual callers never bypass)
    expect(f({ enabled: true, openPositions: null, poolReason: FG, mintHasRiskCooldown: false })).toBe(false);
  });

  it("isBaseMintOnRiskCooldown: true only when a non-fee-generating cooldown is active", () => {
    writeDb({
      P1: { base_mint: "MINT1", base_mint_cooldown_until: future(120), base_mint_cooldown_reason: "repeat fee-generating deploys (3x)" },
    });
    expect(mod.isBaseMintOnRiskCooldown("MINT1")).toBe(false); // only fee-gen

    writeDb({
      P1: { base_mint: "MINT1", base_mint_cooldown_until: future(300), base_mint_cooldown_reason: "repeat fee-generating deploys (3x)" },
      P2: { base_mint: "MINT1", base_mint_cooldown_until: future(60),  base_mint_cooldown_reason: "repeated OOR closes (3x)" },
    });
    expect(mod.isBaseMintOnRiskCooldown("MINT1")).toBe(true); // OOR also active (the double-cooldown edge)

    writeDb({
      P1: { base_mint: "MINT1", base_mint_cooldown_until: past(10), base_mint_cooldown_reason: "low yield" },
    });
    expect(mod.isBaseMintOnRiskCooldown("MINT1")).toBe(false); // expired risk cooldown ignored
    expect(mod.isBaseMintOnRiskCooldown(null)).toBe(false);
    expect(mod.isBaseMintOnRiskCooldown("UNKNOWN")).toBe(false);
  });
});

describe("resolveCooldownWrite — risk precedence + monotonic", () => {
  let resolveCooldownWrite;
  const now = Date.parse("2026-05-16T00:00:00Z");
  const FEE = "repeat fee-generating deploys (3x)";
  const OOR = "repeated OOR closes (3x)";
  const at = (mins) => new Date(now + mins * 60000).toISOString();

  beforeEach(async () => {
    ({ resolveCooldownWrite } = await import("../../pool-memory.js"));
  });

  it("no/expired old cooldown → take new", () => {
    expect(resolveCooldownWrite({ oldUntil: null, oldReason: null, newUntilMs: now + 720 * 60000, newReason: FEE, nowMs: now }))
      .toEqual({ until: at(720), reason: FEE });
    expect(resolveCooldownWrite({ oldUntil: at(-10), oldReason: OOR, newUntilMs: now + 720 * 60000, newReason: FEE, nowMs: now }).reason)
      .toBe(FEE); // expired risk doesn't block a new success
  });

  it("success must NOT erase an active risk cooldown (the bug)", () => {
    const r = resolveCooldownWrite({ oldUntil: at(700), oldReason: OOR, newUntilMs: now + 720 * 60000, newReason: FEE, nowMs: now });
    expect(r.reason).toBe(OOR);          // risk kept
    expect(r.until).toBe(at(720));       // extended, never shortened
  });

  it("risk upgrades over an active success cooldown", () => {
    const r = resolveCooldownWrite({ oldUntil: at(700), oldReason: FEE, newUntilMs: now + 200 * 60000, newReason: OOR, nowMs: now });
    expect(r.reason).toBe(OOR);          // upgraded to risk
    expect(r.until).toBe(at(700));       // max(old,new), never shortened
  });

  it("same class → keep the later expiry, never shorten", () => {
    expect(resolveCooldownWrite({ oldUntil: at(700), oldReason: FEE, newUntilMs: now + 100 * 60000, newReason: FEE, nowMs: now }))
      .toEqual({ until: at(700), reason: FEE }); // old longer kept
    expect(resolveCooldownWrite({ oldUntil: at(100), oldReason: FEE, newUntilMs: now + 700 * 60000, newReason: FEE, nowMs: now }))
      .toEqual({ until: at(700), reason: FEE }); // new longer wins
  });

  it("unknown/low-yield reason is treated as risk (stricter)", () => {
    const r = resolveCooldownWrite({ oldUntil: at(240), oldReason: "low yield", newUntilMs: now + 720 * 60000, newReason: FEE, nowMs: now });
    expect(r.reason).toBe("low yield"); // risk kept, success doesn't erase
  });
});

describe("recordPoolDeploy — fee-gen does not erase OOR (integration)", () => {
  let tmpdir, mod;
  beforeEach(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-cdp-"));
    process.env.MERIDIAN_DATA_DIR = tmpdir;
    vi.resetModules();
    fs.mkdirSync(path.join(tmpdir, "logs"), { recursive: true });
    mod = await import("../../pool-memory.js");
  });
  afterEach(() => { delete process.env.MERIDIAN_DATA_DIR; vi.resetModules(); fs.rmSync(tmpdir, { recursive: true, force: true }); });

  it("3 fee-positive + OOR-closed deploys → cooldown stays OOR (risk)", () => {
    const dep = {
      pool_name: "X-SOL", base_mint: "MINTX",
      pnl_pct: 8, pnl_usd: 5, fees_earned_usd: 5, fee_earned_pct: 2,
      close_reason: "OOR 20m limit reached", strategy: "spot",
    };
    for (let i = 0; i < 3; i++) mod.recordPoolDeploy("POOLX", { ...dep });
    const poolCd = mod.getPoolCooldown("POOLX");
    const mintCd = mod.getBaseMintCooldown("MINTX");
    expect(poolCd?.reason).toBe("repeated OOR closes (3x)");   // NOT fee-generating
    expect(mintCd?.reason).toBe("repeated OOR closes (3x)");
    expect(mod.isBaseMintOnRiskCooldown("MINTX")).toBe(true);  // bypass stays blocked
  });

  it("3 fee-positive non-OOR closes → fee-generating cooldown (bypass still usable)", () => {
    const dep = {
      pool_name: "Y-SOL", base_mint: "MINTY",
      pnl_pct: 6, pnl_usd: 4, fees_earned_usd: 4, fee_earned_pct: 2,
      close_reason: "take profit", strategy: "spot",
    };
    for (let i = 0; i < 3; i++) mod.recordPoolDeploy("POOLY", { ...dep });
    // default scope "token" → fee-gen sets the base-mint cooldown, not pool
    expect(mod.getBaseMintCooldown("MINTY")?.reason).toBe("repeat fee-generating deploys (3x)");
    expect(mod.isBaseMintOnRiskCooldown("MINTY")).toBe(false);
  });
});
