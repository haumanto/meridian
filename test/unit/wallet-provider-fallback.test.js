// Regression: the screener-freeze outage. With balanceProvider="rpc",
// a failing RPC pool returned ZERO_BALANCES (sol:0) with NO Helius
// fallback — the asymmetry that silently froze screening for hours on a
// 5.55-SOL wallet. getWalletBalances must now be symmetric: rpc primary
// fails → Helius fallback resolves the real balance; only a DUAL failure
// surfaces an error (which the screening guard treats as "balance
// unavailable", not an empty wallet). Network layers mocked; isolated
// via MERIDIAN_DATA_DIR + vi.resetModules (the proven suite pattern).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

let tmpdir;
const KEY = bs58.encode(Keypair.generate().secretKey);

// RPC pool that can't serve balance reads (the live failure: 403/400).
const brokenConn = {
  getBalance: async () => { throw new Error("403 Forbidden: Method requires plan upgrade"); },
  getParsedTokenAccountsByOwner: async () => { throw new Error("400 Bad Request: method is not available"); },
};
let connFactory = () => brokenConn;
vi.mock("../../tools/rpc-provider.js", () => ({
  getConnection: () => connFactory(),
}));

// fetchWithRetry serves both the Helius balances URL and Jupiter price.
let heliusOk = true;
vi.mock("../../tools/fetch-retry.js", () => ({
  fetchWithRetry: vi.fn(async (url) => {
    if (String(url).includes("/balances")) {
      if (!heliusOk) return { ok: false, status: 503, statusText: "Service Unavailable" };
      return {
        ok: true,
        json: async () => ({
          balances: [{ mint: "SOL", symbol: "SOL", balance: 5.55, pricePerToken: 160, usdValue: 888 }],
          totalUsdValue: 888,
        }),
      };
    }
    return { ok: true, json: async () => ({}) }; // Jupiter price (unused here)
  }),
}));

async function freshWallet() {
  vi.resetModules();
  return import("../../tools/wallet.js");
}

describe("getWalletBalances — symmetric rpc→helius fallback", () => {
  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "wal-fb-"));
    process.env.MERIDIAN_DATA_DIR = tmpdir;
    fs.mkdirSync(path.join(tmpdir, "logs"), { recursive: true });
    process.env.WALLET_PRIVATE_KEY = KEY;
    process.env.HELIUS_API_KEY = "test-helius-key";
    process.env.BALANCE_PROVIDER = "rpc";
    connFactory = () => brokenConn;
    heliusOk = true;
  });
  afterEach(() => {
    delete process.env.MERIDIAN_DATA_DIR;
    delete process.env.BALANCE_PROVIDER;
    delete process.env.HELIUS_API_KEY;
    delete process.env.WALLET_PRIVATE_KEY;
    vi.resetModules();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it("rpc primary fails → Helius fallback resolves the real balance (no error)", async () => {
    const { getWalletBalances } = await freshWallet();
    const r = await getWalletBalances({ force: true });
    expect(r.error).toBeFalsy();
    expect(r.sol).toBe(5.55);
    expect(r.sol_usd).toBe(888);
  });

  it("rpc + Helius both fail → error surfaced, sol 0 (caller → 'balance unavailable')", async () => {
    heliusOk = false; // Helius also down
    const { getWalletBalances } = await freshWallet();
    const r = await getWalletBalances({ force: true });
    expect(r.error).toBeTruthy();
    expect(r.sol).toBe(0);
  });
});
