// Multi-provider RPC failover: idempotent reads retry the next provider
// on a transient error; transaction sends never failover.

import { describe, it, expect, beforeEach, vi } from "vitest";

describe("rpc-provider failover", () => {
  let getConnection, _setConnectionsForTest, _resetRpcProvider, _isTransient;

  beforeEach(async () => {
    const mod = await import("../../tools/rpc-provider.js");
    getConnection = mod.getConnection;
    _setConnectionsForTest = mod._setConnectionsForTest;
    _resetRpcProvider = mod._resetRpcProvider;
    _isTransient = mod._isTransient;
    _resetRpcProvider();
  });

  it("classifies transient vs fatal errors", () => {
    expect(_isTransient(new Error("fetch failed"))).toBe(true);
    expect(_isTransient(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(_isTransient(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(_isTransient(new Error("429 Too Many Requests"))).toBe(true);
    expect(_isTransient(new Error("Invalid param: bad pubkey"))).toBe(false);
    expect(_isTransient(null)).toBe(false);
  });

  it("fails a read over to the next provider on a transient error", async () => {
    const A = { rpcEndpoint: "https://a.example", getSlot: vi.fn().mockRejectedValue(new Error("fetch failed")) };
    const B = { rpcEndpoint: "https://b.example", getSlot: vi.fn().mockResolvedValue(12345) };
    _setConnectionsForTest([A, B]);

    const slot = await getConnection().getSlot();
    expect(slot).toBe(12345);
    expect(A.getSlot).toHaveBeenCalledTimes(1);
    expect(B.getSlot).toHaveBeenCalledTimes(1);
  });

  it("does NOT fail over on a non-transient read error", async () => {
    const A = { rpcEndpoint: "https://a.example", getAccountInfo: vi.fn().mockRejectedValue(new Error("Invalid pubkey")) };
    const B = { rpcEndpoint: "https://b.example", getAccountInfo: vi.fn().mockResolvedValue({ lamports: 1 }) };
    _setConnectionsForTest([A, B]);

    await expect(getConnection().getAccountInfo("bad")).rejects.toThrow("Invalid pubkey");
    expect(A.getAccountInfo).toHaveBeenCalledTimes(1);
    expect(B.getAccountInfo).not.toHaveBeenCalled();
  });

  it("never fails over a transaction send, even on a transient error", async () => {
    const A = {
      rpcEndpoint: "https://a.example",
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("fetch failed")),
    };
    const B = {
      rpcEndpoint: "https://b.example",
      sendRawTransaction: vi.fn().mockResolvedValue("sigB"),
    };
    _setConnectionsForTest([A, B]);

    // send* is not in the failover whitelist → bound to primary, error propagates
    await expect(getConnection().sendRawTransaction(Buffer.from([]))).rejects.toThrow("fetch failed");
    expect(A.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(B.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("single provider: read error propagates (no phantom failover)", async () => {
    const A = { rpcEndpoint: "https://a.example", getSlot: vi.fn().mockRejectedValue(new Error("fetch failed")) };
    _setConnectionsForTest([A]);

    await expect(getConnection().getSlot()).rejects.toThrow("fetch failed");
    expect(A.getSlot).toHaveBeenCalledTimes(1);
  });

  it("passes through non-method properties to the primary", () => {
    const A = { rpcEndpoint: "https://a.example", commitment: "confirmed" };
    const B = { rpcEndpoint: "https://b.example", commitment: "processed" };
    _setConnectionsForTest([A, B]);
    expect(getConnection().rpcEndpoint).toBe("https://a.example");
    expect(getConnection().commitment).toBe("confirmed");
  });
});
