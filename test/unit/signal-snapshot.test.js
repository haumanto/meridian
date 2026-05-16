// Darwin fix: staged screening signals must reach the performance record
// (signal_snapshot) so signal-weights has real inputs. Covers the
// staging↔retrieval bridge, the snapshot builder, and the back-compat
// reader. lessons.js / state.js use cwd-relative JSON, so the blocks
// that touch them chdir to a tmpdir (pool-cooldown.test.js pattern).

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

describe("signal-tracker stage ↔ getAndClear", () => {
  let st;
  beforeEach(async () => { st = await import("../../signal-tracker.js"); });

  it("retrieves by pool and clears (second get is null)", () => {
    st.stageSignals("POOL_A", { base_mint: "MINT_A", organic_score: 81 });
    expect(st.getAndClearStagedSignals("POOL_A")).toMatchObject({ base_mint: "MINT_A", organic_score: 81 });
    expect(st.getAndClearStagedSignals("POOL_A")).toBeNull();
  });

  it("falls back to base-mint lookup when pool addr differs", () => {
    st.stageSignals("POOL_B", { base_mint: "MINT_B", volatility: 2 });
    expect(st.getAndClearStagedSignals("OTHER_POOL", "MINT_B")).toMatchObject({ volatility: 2 });
    // both indexes cleared
    expect(st.getAndClearStagedSignals("POOL_B")).toBeNull();
    expect(st.getAndClearStagedSignals(null, "MINT_B")).toBeNull();
  });

  it("strips staged_at and returns null for unknown / empty keys", () => {
    st.stageSignals("POOL_C", { base_mint: "MINT_C", mcap: 1 });
    const got = st.getAndClearStagedSignals("POOL_C");
    expect(got).not.toHaveProperty("staged_at");
    expect(st.getAndClearStagedSignals("NOPE")).toBeNull();
    expect(st.getAndClearStagedSignals(null, null)).toBeNull();
  });
});

describe("getEntrySignalSnapshot back-compat", () => {
  let getEntrySignalSnapshot;
  beforeAll(async () => { ({ getEntrySignalSnapshot } = await import("../../signal-weights.js")); });

  it("prefers an explicit signal_snapshot", () => {
    expect(getEntrySignalSnapshot({ signal_snapshot: { organic_score: 90 }, organic_score: 10 }))
      .toEqual({ organic_score: 90 });
  });
  it("reconstructs from flat fields when no snapshot (old records)", () => {
    const snap = getEntrySignalSnapshot({ organic_score: 70, volatility: 3, pnl_usd: 5 });
    expect(snap.organic_score).toBe(70);
    expect(snap.volatility).toBe(3);
    expect(snap).not.toHaveProperty("pnl_usd"); // only SIGNAL_NAMES
  });
  it("null when neither snapshot nor flat signals present", () => {
    expect(getEntrySignalSnapshot({ pnl_usd: 5 })).toBeNull();
    expect(getEntrySignalSnapshot(null)).toBeNull();
  });
});

describe("buildSignalSnapshot (lessons)", () => {
  let tmpdir, cwd, lessons;
  beforeEach(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-sig-"));
    cwd = process.cwd(); process.chdir(tmpdir);
    fs.mkdirSync(path.join(tmpdir, "logs"), { recursive: true });
    lessons = await import("../../lessons.js");
  });
  afterEach(() => { process.chdir(cwd); fs.rmSync(tmpdir, { recursive: true, force: true }); });

  it("merges staged ∪ flat perf, includes base_mint", () => {
    const snap = lessons.buildSignalSnapshot(
      { base_mint: "MINT1", organic_score: 65, volatility: 2 },
      { organic_score: 82, fee_tvl_ratio: 0.05 }, // staged wins on overlap
    );
    expect(snap).toMatchObject({
      base_mint: "MINT1", organic_score: 82, fee_tvl_ratio: 0.05, volatility: 2,
    });
  });
  it("returns null when there is no usable signal", () => {
    expect(lessons.buildSignalSnapshot({}, null)).toBeNull();
    expect(lessons.buildSignalSnapshot({ pnl_usd: 1 }, null)).toBeNull();
  });
});

describe("state.getTrackedPositions", () => {
  let tmpdir, cwd, state;
  beforeEach(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-stp-"));
    cwd = process.cwd(); process.chdir(tmpdir);
    state = await import("../../state.js");
  });
  afterEach(() => { process.chdir(cwd); fs.rmSync(tmpdir, { recursive: true, force: true }); });

  it("openOnly filters closed; default returns all", () => {
    fs.writeFileSync(path.join(tmpdir, "state.json"), JSON.stringify({
      positions: { A: { closed: false }, B: { closed: true }, C: {} },
    }));
    expect(state.getTrackedPositions().length).toBe(3);
    expect(state.getTrackedPositions(true).length).toBe(2); // A + C (no closed flag)
  });
  it("empty / missing state → []", () => {
    expect(state.getTrackedPositions(true)).toEqual([]);
  });
});
