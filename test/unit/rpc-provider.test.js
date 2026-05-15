// Two-tier RPC: whitelisted reads fail over public-first → keyed;
// transaction sends are pinned to the keyed send connection and never
// fail over.

import { describe, it, expect, beforeEach, vi } from "vitest";

describe("rpc-provider two-tier", () => {
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

  it("reads try the public tier before the keyed tier", async () => {
    const pub = { rpcEndpoint: "https://drpc.public", getSlot: vi.fn().mockResolvedValue(111) };
    const keyed = { rpcEndpoint: "https://helius.keyed", getSlot: vi.fn().mockResolvedValue(999) };
    _setConnectionsForTest([pub, keyed], keyed);

    const slot = await getConnection().getSlot();
    expect(slot).toBe(111); // public answered first
    expect(pub.getSlot).toHaveBeenCalledTimes(1);
    expect(keyed.getSlot).not.toHaveBeenCalled();
  });

  it("reads fail over public → keyed on a transient error", async () => {
    const pub = { rpcEndpoint: "https://drpc.public", getProgramAccounts: vi.fn().mockRejectedValue(new Error("429 Too Many Requests")) };
    const keyed = { rpcEndpoint: "https://helius.keyed", getProgramAccounts: vi.fn().mockResolvedValue([{ ok: true }]) };
    _setConnectionsForTest([pub, keyed], keyed);

    const res = await getConnection().getProgramAccounts("prog");
    expect(res).toEqual([{ ok: true }]);
    expect(pub.getProgramAccounts).toHaveBeenCalledTimes(1);
    expect(keyed.getProgramAccounts).toHaveBeenCalledTimes(1);
  });

  it("does NOT fail over on a non-transient read error", async () => {
    const pub = { rpcEndpoint: "https://drpc.public", getAccountInfo: vi.fn().mockRejectedValue(new Error("Invalid pubkey")) };
    const keyed = { rpcEndpoint: "https://helius.keyed", getAccountInfo: vi.fn().mockResolvedValue({ lamports: 1 }) };
    _setConnectionsForTest([pub, keyed], keyed);

    await expect(getConnection().getAccountInfo("bad")).rejects.toThrow("Invalid pubkey");
    expect(pub.getAccountInfo).toHaveBeenCalledTimes(1);
    expect(keyed.getAccountInfo).not.toHaveBeenCalled();
  });

  it("sends go to the KEYED conn even though public is read-primary, and never fail over", async () => {
    const pub = {
      rpcEndpoint: "https://drpc.public",
      sendRawTransaction: vi.fn().mockResolvedValue("PUBLIC_SIG"),
    };
    const keyed = {
      rpcEndpoint: "https://helius.keyed",
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("fetch failed")),
    };
    _setConnectionsForTest([pub, keyed], keyed);

    // send* targets the keyed sendConn, not the public read-primary; no failover
    await expect(getConnection().sendRawTransaction(Buffer.from([]))).rejects.toThrow("fetch failed");
    expect(keyed.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(pub.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("no keyed tier: sendConn degrades to the first read conn", async () => {
    const pub = { rpcEndpoint: "https://drpc.public", sendRawTransaction: vi.fn().mockResolvedValue("SIG") };
    _setConnectionsForTest([pub]); // sendConn omitted → defaults to readConns[0]

    const sig = await getConnection().sendRawTransaction(Buffer.from([]));
    expect(sig).toBe("SIG");
    expect(pub.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("single provider (back-compat): reads and sends both use it", async () => {
    const only = {
      rpcEndpoint: "https://only.rpc",
      getSlot: vi.fn().mockRejectedValue(new Error("fetch failed")),
      sendRawTransaction: vi.fn().mockResolvedValue("SIG"),
    };
    _setConnectionsForTest([only], only);

    await expect(getConnection().getSlot()).rejects.toThrow("fetch failed"); // no phantom failover
    expect(only.getSlot).toHaveBeenCalledTimes(1);
    expect(await getConnection().sendRawTransaction(Buffer.from([]))).toBe("SIG");
  });

  it("passes non-method properties through to the keyed send conn", () => {
    const pub = { rpcEndpoint: "https://drpc.public", commitment: "processed" };
    const keyed = { rpcEndpoint: "https://helius.keyed", commitment: "confirmed" };
    _setConnectionsForTest([pub, keyed], keyed);
    expect(getConnection().rpcEndpoint).toBe("https://helius.keyed");
    expect(getConnection().commitment).toBe("confirmed");
  });
});
