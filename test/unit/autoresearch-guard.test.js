// The autoresearch startup guard is the ONLY thing standing between the
// experiment instance and (a) production data, (b) the production
// wallet, (c) running uncapped. Pure decision = exhaustively testable.

import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { evaluateAutoresearchGuard, deriveSolPubkey } from "../../autoresearch-guard.js";

const keyA = bs58.encode(Keypair.generate().secretKey);
const keyB = bs58.encode(Keypair.generate().secretKey);
const goodCfg = { autoresearch: { maxWalletSol: 0.05, dailyLossLimitSol: 0.02 } };
const paths = { root: "/repo", dataDir: "/repo/profiles/autoresearch" };

const base = (over = {}) => ({
  env: {
    MERIDIAN_PROFILE: "autoresearch",
    MERIDIAN_DATA_DIR: "profiles/autoresearch",
    WALLET_PRIVATE_KEY: keyA,
    AUTORESEARCH_WALLET_PRIVATE_KEY: keyB,
    ...over,
  },
  paths,
  config: goodCfg,
});

describe("evaluateAutoresearchGuard", () => {
  it("no-op when not the autoresearch profile (main agent untouched)", () => {
    const r = evaluateAutoresearchGuard({ env: { MERIDIAN_PROFILE: undefined }, paths, config: {} });
    expect(r).toEqual({ profile: false });
  });

  it("aborts when MERIDIAN_DATA_DIR is unset", () => {
    const r = evaluateAutoresearchGuard(base({ MERIDIAN_DATA_DIR: undefined }));
    expect(r).toMatchObject({ profile: true, ok: false });
    expect(r.error).toMatch(/MERIDIAN_DATA_DIR is not set/);
  });

  it("aborts when dataDir resolves to the project root", () => {
    const r = evaluateAutoresearchGuard({ ...base(), paths: { root: "/repo", dataDir: "/repo" } });
    expect(r).toMatchObject({ profile: true, ok: false });
    expect(r.error).toMatch(/project root/);
  });

  it("aborts when the AR wallet key is missing", () => {
    const r = evaluateAutoresearchGuard(base({ AUTORESEARCH_WALLET_PRIVATE_KEY: "" }));
    expect(r).toMatchObject({ profile: true, ok: false });
    expect(r.error).toMatch(/AUTORESEARCH_WALLET_PRIVATE_KEY is not set/);
  });

  it("aborts when the AR wallet key is not valid base58 secret", () => {
    const r = evaluateAutoresearchGuard(base({ AUTORESEARCH_WALLET_PRIVATE_KEY: "not-a-key" }));
    expect(r).toMatchObject({ profile: true, ok: false });
    expect(r.error).toMatch(/not a valid base58 secret/);
  });

  it("aborts when AR wallet === production wallet", () => {
    const r = evaluateAutoresearchGuard(base({ AUTORESEARCH_WALLET_PRIVATE_KEY: keyA })); // == WALLET_PRIVATE_KEY
    expect(r).toMatchObject({ profile: true, ok: false });
    expect(r.error).toMatch(/equals the production wallet/);
  });

  it("aborts when maxWalletSol is unset/zero/negative", () => {
    for (const v of [undefined, 0, -1, NaN]) {
      const r = evaluateAutoresearchGuard({ ...base(), config: { autoresearch: { maxWalletSol: v, dailyLossLimitSol: 0.02 } } });
      expect(r).toMatchObject({ profile: true, ok: false });
      expect(r.error).toMatch(/maxWalletSol must be a positive number/);
    }
  });

  it("aborts when dailyLossLimitSol is unset/zero/negative", () => {
    for (const v of [undefined, 0, -1, NaN]) {
      const r = evaluateAutoresearchGuard({ ...base(), config: { autoresearch: { maxWalletSol: 0.05, dailyLossLimitSol: v } } });
      expect(r).toMatchObject({ profile: true, ok: false });
      expect(r.error).toMatch(/dailyLossLimitSol must be a positive number/);
    }
  });

  it("proceeds when isolated + distinct wallet + capped, returning the AR key to swap", () => {
    const r = evaluateAutoresearchGuard(base());
    expect(r.profile).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.walletKey).toBe(keyB);
    expect(r.pubkey).toBe(deriveSolPubkey(keyB));
    expect(r.logMsg).toMatch(/guard passed/);
    // never leaks a secret into the log line
    expect(r.logMsg).not.toContain(keyB);
  });

  it("proceeds even if the prod key is absent/garbage (only the collision check needs it)", () => {
    const r = evaluateAutoresearchGuard(base({ WALLET_PRIVATE_KEY: "garbage" }));
    expect(r).toMatchObject({ profile: true, ok: true, walletKey: keyB });
  });
});
