// assembleBalancesFromRpc must produce the EXACT getWalletBalances shape
// from raw JSON-RPC data (the Helius-outage fallback). 6+ callers +
// dashboard + LLM prompt depend on this shape, so test it directly
// (pure, no network).

import { describe, it, expect, beforeAll } from "vitest";

let assembleBalancesFromRpc, SOL, USDC;
beforeAll(async () => {
  ({ assembleBalancesFromRpc } = await import("../../tools/wallet.js"));
  ({ config } = await import("../../config.js"));
  SOL = config.tokens.SOL;
  USDC = config.tokens.USDC;
});
let config;

const W = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("assembleBalancesFromRpc", () => {
  it("maps SOL balance + price (no tokens)", () => {
    const r = assembleBalancesFromRpc({
      lamports: 2_500_000_000, tokenAccounts: [],
      priceByMint: { [SOL]: 160 }, walletAddress: W,
    });
    expect(r).toEqual({
      wallet: W, sol: 2.5, sol_price: 160, sol_usd: 400,
      usdc: 0, tokens: [], total_usd: 400,
    });
    // exact shape — no stray/missing keys
    expect(Object.keys(r).sort()).toEqual(
      ["sol", "sol_price", "sol_usd", "tokens", "total_usd", "usdc", "wallet"],
    );
  });

  it("picks USDC, prices tokens, sums total_usd", () => {
    const r = assembleBalancesFromRpc({
      lamports: 1_000_000_000,
      tokenAccounts: [
        { mint: USDC, uiAmount: 50 },
        { mint: "MintAAA1111111111111111111111111111111111111", uiAmount: 10 },
      ],
      priceByMint: { [SOL]: 100, [USDC]: 1, "MintAAA1111111111111111111111111111111111111": 2 },
      walletAddress: W,
    });
    expect(r.sol).toBe(1);
    expect(r.sol_usd).toBe(100);
    expect(r.usdc).toBe(50);
    const tok = r.tokens.find((t) => t.mint.startsWith("MintAAA"));
    expect(tok).toEqual({ mint: "MintAAA1111111111111111111111111111111111111", symbol: "MintAAA1", balance: 10, usd: 20 });
    // total = sol 100 + usdc 50 + tokenAAA 20
    expect(r.total_usd).toBe(170);
  });

  it("missing price → usd null and excluded from total", () => {
    const r = assembleBalancesFromRpc({
      lamports: 0,
      tokenAccounts: [{ mint: "NoPrice22222222222222222222222222222222222222", uiAmount: 999 }],
      priceByMint: { [SOL]: 100 }, walletAddress: W,
    });
    expect(r.tokens[0].usd).toBeNull();
    expect(r.total_usd).toBe(0); // sol 0 + no priced tokens
  });

  it("collapses duplicate accounts of the same mint", () => {
    const m = "DupMint333333333333333333333333333333333333333";
    const r = assembleBalancesFromRpc({
      lamports: 0,
      tokenAccounts: [{ mint: m, uiAmount: 3 }, { mint: m, uiAmount: 4 }],
      priceByMint: { [m]: 1 }, walletAddress: W,
    });
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0].balance).toBe(7);
    expect(r.tokens[0].usd).toBe(7);
  });

  it("empty wallet → all zeros, wallet set, no error key", () => {
    const r = assembleBalancesFromRpc({
      lamports: 0, tokenAccounts: [], priceByMint: {}, walletAddress: W,
    });
    expect(r).toEqual({
      wallet: W, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0,
    });
    expect("error" in r).toBe(false);
  });

  it("tolerates missing price map / null SOL price", () => {
    const r = assembleBalancesFromRpc({
      lamports: 3_000_000_000, tokenAccounts: [], priceByMint: undefined, walletAddress: W,
    });
    expect(r.sol).toBe(3);
    expect(r.sol_price).toBe(0);
    expect(r.sol_usd).toBe(0);
    expect(r.total_usd).toBe(0);
  });
});
