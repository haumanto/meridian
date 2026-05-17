// transactions-ledger.js — the on-chain action ledger that the executor
// writes fire-and-forget. formatTxEntry is the pure mapping that runs in
// the live trade path; it must NEVER throw and must record exactly the 4
// known tool types. append/read/rotate are I/O, isolated via
// MERIDIAN_DATA_DIR + vi.resetModules (per test/unit/rate-limit.test.js)
// so nothing touches the live transactions.jsonl.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

let mod, tmpdir;
beforeEach(async () => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "txledger-"));
  process.env.MERIDIAN_DATA_DIR = tmpdir;
  vi.resetModules();
  mod = await import("../../transactions-ledger.js");
});
afterEach(() => {
  delete process.env.MERIDIAN_DATA_DIR;
  vi.resetModules();
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe("formatTxEntry (pure, runs in trade path — never throws)", () => {
  it("deploy: txs[0] fallback + amount + pool", () => {
    const e = mod.formatTxEntry("deploy_position",
      { amount_sol: 0.3, pool_address: "POOL1", pool_name: "X-SOL" },
      { txs: ["SIGdeploy"], position: "POS1", pool: "POOL1", pool_name: "X-SOL" });
    expect(e).toMatchObject({ type: "deploy", tx: "SIGdeploy", pool: "POOL1", pool_name: "X-SOL", position: "POS1", amount_sol: 0.3 });
  });
  it("deploy: falls back to result.tx when no txs[]", () => {
    expect(mod.formatTxEntry("deploy_position", { amount_y: 0.5 }, { tx: "SIG2" }))
      .toMatchObject({ type: "deploy", tx: "SIG2", amount_sol: 0.5 });
  });
  it("close: pnl + reason default", () => {
    const e = mod.formatTxEntry("close_position",
      { position_address: "POS9" }, { pnl_usd: 12.5, pnl_pct: 4.2, pool: "P", pool_name: "Y-SOL", tx: "SIGc" });
    expect(e).toMatchObject({ type: "close", tx: "SIGc", position: "POS9", pnl_usd: 12.5, pnl_pct: 4.2, reason: "agent decision" });
  });
  it("swap + claim recognised", () => {
    expect(mod.formatTxEntry("swap_token", { input_mint: "AAA", output_mint: "SOL" }, { tx: "S", amount_out: 1.2 }))
      .toMatchObject({ type: "swap", tx: "S", token_amount: 1.2 });
    expect(mod.formatTxEntry("claim_fees", { position_address: "P" }, { txs: ["SIGk"] }))
      .toMatchObject({ type: "claim", tx: "SIGk", position: "P" });
  });
  it("unknown tool → null; malformed inputs → no throw", () => {
    expect(mod.formatTxEntry("get_my_positions", {}, {})).toBeNull();
    expect(() => mod.formatTxEntry("deploy_position", null, null)).not.toThrow();
    expect(() => mod.formatTxEntry(undefined, undefined, undefined)).not.toThrow();
    expect(mod.formatTxEntry("close_position", {}, {})).toMatchObject({ type: "close", pnl_usd: null });
  });
});

describe("append / read / rotate", () => {
  it("missing file → empty", () => {
    expect(mod.readTransactions(tmpdir)).toEqual({ count: 0, entries: [] });
  });
  it("append then read newest-first; tolerates a trailing partial line", () => {
    mod.appendTransaction({ type: "deploy", tx: "A" }, tmpdir);
    mod.appendTransaction({ type: "close", tx: "B" }, tmpdir);
    fs.appendFileSync(mod.txLedgerPath(tmpdir), '{"type":"swap","tx":"C"'); // truncated, no newline
    const r = mod.readTransactions(tmpdir);
    expect(r.count).toBe(2);
    expect(r.entries.map((e) => e.tx)).toEqual(["B", "A"]); // reversed
    expect(r.entries[0].ts).toBeTruthy();
  });
  it("limit slices to newest N", () => {
    for (let i = 0; i < 10; i++) mod.appendTransaction({ type: "deploy", n: i }, tmpdir);
    const r = mod.readTransactions(tmpdir, { limit: 3 });
    expect(r.count).toBe(10);
    expect(r.entries.map((e) => e.n)).toEqual([9, 8, 7]);
  });
  it("rotateLedger keeps the newest N past the cap", () => {
    for (let i = 0; i < 50; i++) mod.appendTransaction({ type: "deploy", n: i }, tmpdir);
    mod.rotateLedger(tmpdir, { capBytes: 1, keep: 5 });
    const r = mod.readTransactions(tmpdir, { limit: 999 });
    expect(r.count).toBe(5);
    expect(r.entries.map((e) => e.n)).toEqual([49, 48, 47, 46, 45]);
  });
  it("unwritable baseDir → logs, never throws", () => {
    const filePath = path.join(tmpdir, "notadir");
    fs.writeFileSync(filePath, "x"); // baseDir points at a file → mkdir fails
    expect(() => mod.appendTransaction({ type: "deploy" }, filePath)).not.toThrow();
  });
});

describe("reconstructFromHistory (pure backfill)", () => {
  it("synthesises close+deploy entries, tx:null, reconstructed, time-sorted", () => {
    const out = mod.reconstructFromHistory({
      lessons: { performance: [
        { recorded_at: "2026-05-02T00:00:00Z", pool: "P2", pool_name: "B-SOL", pnl_usd: 5, pnl_pct: 2, close_reason: "tp" },
      ] },
      poolMemory: { P1: { pool_name: "A-SOL", deploys: [{ deployed_at: "2026-05-01T00:00:00Z", amount_sol: 0.3 }] } },
    });
    expect(out.map((e) => e.type)).toEqual(["deploy", "close"]); // sorted by ts asc
    expect(out.every((e) => e.tx === null && e.reconstructed === true)).toBe(true);
  });
  it("tolerates missing/garbage input", () => {
    expect(mod.reconstructFromHistory()).toEqual([]);
    expect(mod.reconstructFromHistory({ lessons: null, poolMemory: 42 })).toEqual([]);
  });
});
