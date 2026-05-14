// Boot validation tests. validateBoot() must refuse to start a misconfigured
// agent so the operator can't lose money to a silently broken daemon.

import { describe, it, expect } from "vitest";
import { validateBoot } from "../../config.js";

// 64 zero bytes as a JSON array — decodes/parses to length 64; not a real wallet.
// Using JSON-array form avoids hand-encoding base58 in test fixtures.
const VALID_BS58_64_BYTE_KEY = JSON.stringify(new Array(64).fill(0));

const MODELS_OK = {
  screeningModel: "test-screener",
  managementModel: "test-manager",
  generalModel: "test-general",
};

describe("validateBoot", () => {
  it("passes with all-valid inputs", () => {
    const errors = validateBoot({
      env: {
        WALLET_PRIVATE_KEY: VALID_BS58_64_BYTE_KEY,
        RPC_URL: "https://example.com",
        LLM_API_KEY: "k",
      },
      userConfig: {},
      modelConfig: MODELS_OK,
    });
    expect(errors).toEqual([]);
  });

  it("rejects when WALLET_PRIVATE_KEY is missing", () => {
    const errors = validateBoot({
      env: { RPC_URL: "https://example.com", LLM_API_KEY: "k" },
      userConfig: {},
      modelConfig: MODELS_OK,
    });
    expect(errors.some((e) => /WALLET_PRIVATE_KEY/.test(e))).toBe(true);
  });

  it("rejects when WALLET_PRIVATE_KEY is malformed base58", () => {
    const errors = validateBoot({
      env: { WALLET_PRIVATE_KEY: "not-a-real-key-too-short", RPC_URL: "https://example.com", LLM_API_KEY: "k" },
      userConfig: {},
      modelConfig: MODELS_OK,
    });
    expect(errors.some((e) => /does not decode/.test(e))).toBe(true);
  });

  it("rejects when RPC_URL is http://", () => {
    const errors = validateBoot({
      env: {
        WALLET_PRIVATE_KEY: VALID_BS58_64_BYTE_KEY,
        RPC_URL: "http://insecure.example.com",
        LLM_API_KEY: "k",
      },
      userConfig: {},
      modelConfig: MODELS_OK,
    });
    expect(errors.some((e) => /must use https/.test(e))).toBe(true);
  });

  it("allows http when rpcUrlMustBeHttps:false", () => {
    const errors = validateBoot({
      env: {
        WALLET_PRIVATE_KEY: VALID_BS58_64_BYTE_KEY,
        RPC_URL: "http://localhost:8899",
        LLM_API_KEY: "k",
      },
      userConfig: { rpcUrlMustBeHttps: false },
      modelConfig: MODELS_OK,
    });
    expect(errors.every((e) => !/must use https/.test(e))).toBe(true);
  });

  it("rejects when LLM_API_KEY and OPENROUTER_API_KEY are both missing", () => {
    const errors = validateBoot({
      env: { WALLET_PRIVATE_KEY: VALID_BS58_64_BYTE_KEY, RPC_URL: "https://example.com" },
      userConfig: {},
      modelConfig: MODELS_OK,
    });
    expect(errors.some((e) => /LLM_API_KEY/.test(e))).toBe(true);
  });

  it("accepts OPENROUTER_API_KEY as fallback for LLM_API_KEY", () => {
    const errors = validateBoot({
      env: {
        WALLET_PRIVATE_KEY: VALID_BS58_64_BYTE_KEY,
        RPC_URL: "https://example.com",
        OPENROUTER_API_KEY: "or-key",
      },
      userConfig: {},
      modelConfig: MODELS_OK,
    });
    expect(errors.every((e) => !/LLM_API_KEY/.test(e))).toBe(true);
  });

  it("rejects when any per-role model slug is empty", () => {
    const errors = validateBoot({
      env: { WALLET_PRIVATE_KEY: VALID_BS58_64_BYTE_KEY, RPC_URL: "https://example.com", LLM_API_KEY: "k" },
      userConfig: {},
      modelConfig: { ...MODELS_OK, screeningModel: "" },
    });
    expect(errors.some((e) => /screeningModel/.test(e))).toBe(true);
  });

  it("accepts JSON-array wallet key with 64 ints", () => {
    const errors = validateBoot({
      env: {
        WALLET_PRIVATE_KEY: JSON.stringify(new Array(64).fill(7)),
        RPC_URL: "https://example.com",
        LLM_API_KEY: "k",
      },
      userConfig: {},
      modelConfig: MODELS_OK,
    });
    expect(errors.every((e) => !/WALLET_PRIVATE_KEY/.test(e))).toBe(true);
  });

  it("rejects DRY_RUN env vs config mismatch", () => {
    const errors = validateBoot({
      env: { WALLET_PRIVATE_KEY: VALID_BS58_64_BYTE_KEY, RPC_URL: "https://example.com", LLM_API_KEY: "k", DRY_RUN: "true" },
      userConfig: { dryRun: false },
      modelConfig: MODELS_OK,
    });
    expect(errors.some((e) => /DRY_RUN/.test(e))).toBe(true);
  });
});
