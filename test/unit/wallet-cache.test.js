// Balance-cache freshness gate. This decides whether a monitoring read
// may reuse the cached balance. The safety contract: force always
// bypasses, errors/zero are never served, and a wallet-key change
// invalidates. Pure → exhaustively testable without network.

import { describe, it, expect } from "vitest";
import { isBalanceCacheFresh } from "../../tools/wallet.js";

const KEY = "WaLLeTpubKey1111111111111111111111111111111";
const good = { ts: 1_000_000, key: KEY, val: { sol: 2.5 } };

describe("isBalanceCacheFresh", () => {
  it("fresh: same key, within ttl, no error, not forced", () => {
    expect(isBalanceCacheFresh({ cache: good, key: KEY, now: 1_010_000, ttl: 20_000, force: false })).toBe(true);
  });

  it("expired: age >= ttl", () => {
    expect(isBalanceCacheFresh({ cache: good, key: KEY, now: 1_021_000, ttl: 20_000, force: false })).toBe(false);
  });

  it("force:true always bypasses (fund-moving callers)", () => {
    expect(isBalanceCacheFresh({ cache: good, key: KEY, now: 1_000_001, ttl: 20_000, force: true })).toBe(false);
  });

  it("wallet key change invalidates (main vs AR / different wallet)", () => {
    expect(isBalanceCacheFresh({ cache: good, key: "OTHER", now: 1_000_001, ttl: 20_000, force: false })).toBe(false);
  });

  it("never serves a cached error / ZERO_BALANCES", () => {
    const errCache = { ts: 1_000_000, key: KEY, val: { sol: 0, error: "RPC down" } };
    expect(isBalanceCacheFresh({ cache: errCache, key: KEY, now: 1_000_500, ttl: 20_000, force: false })).toBe(false);
  });

  it("empty / missing cache → not fresh", () => {
    expect(isBalanceCacheFresh({ cache: { ts: 0, key: null, val: null }, key: KEY, now: 5, ttl: 20_000, force: false })).toBe(false);
    expect(isBalanceCacheFresh({ cache: undefined, key: KEY, now: 5, ttl: 20_000, force: false })).toBe(false);
  });

  it("ttl <= 0 disables caching (never fresh)", () => {
    expect(isBalanceCacheFresh({ cache: good, key: KEY, now: 1_000_000, ttl: 0, force: false })).toBe(false);
  });
});
