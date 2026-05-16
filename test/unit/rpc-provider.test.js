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
    // Free-tier / plan-gate method blocks → fail over to the keyed tier.
    expect(_isTransient(Object.assign(new Error("method is not available on freetier, please upgrade to paid tier"), { code: 35 }))).toBe(true);
    expect(_isTransient(new Error("method is not available on freetier, please upgrade to paid tier"))).toBe(true);
    expect(_isTransient(Object.assign(new Error("Method not found"), { code: -32601 }))).toBe(true);
    expect(_isTransient(Object.assign(new Error("x"), { status: 402 }))).toBe(true);
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

describe("buildReadOrder (keyed round-robin)", () => {
  let buildReadOrder;
  beforeEach(async () => {
    ({ buildReadOrder } = await import("../../tools/rpc-provider.js"));
  });

  const P = ["p0"]; // public (fixed)
  const K = ["k0", "k1", "k2", "k3"]; // keyed

  it("public stays first & fixed; keyed start rotates per counter", () => {
    expect(buildReadOrder(P, K, 0)).toEqual(["p0", "k0", "k1", "k2", "k3"]);
    expect(buildReadOrder(P, K, 1)).toEqual(["p0", "k1", "k2", "k3", "k0"]);
    expect(buildReadOrder(P, K, 2)).toEqual(["p0", "k2", "k3", "k0", "k1"]);
    expect(buildReadOrder(P, K, 4)).toEqual(["p0", "k0", "k1", "k2", "k3"]); // wraps
  });

  it("every connection appears exactly once (full failover coverage)", () => {
    for (let c = 0; c < 10; c++) {
      const order = buildReadOrder(P, K, c);
      expect(order.length).toBe(P.length + K.length);
      expect(new Set(order).size).toBe(order.length);
      expect(order[0]).toBe("p0"); // public always first
    }
  });

  it("≤1 keyed → no rotation (legacy/single-RPC byte-identical)", () => {
    expect(buildReadOrder(["p0"], ["k0"], 5)).toEqual(["p0", "k0"]);
    expect(buildReadOrder([], ["k0"], 9)).toEqual(["k0"]);
    expect(buildReadOrder([], [], 3)).toEqual([]);
  });

  it("no public tier → rotates keyed only", () => {
    expect(buildReadOrder([], K, 1)).toEqual(["k1", "k2", "k3", "k0"]);
  });

  it("handles large/!finite counter defensively", () => {
    expect(buildReadOrder(P, K, 1e9).length).toBe(5);
    expect(buildReadOrder(P, K, NaN)).toEqual(["p0", "k0", "k1", "k2", "k3"]);
  });
});

describe("rpc-provider keyed round-robin (behavioral)", () => {
  let getConnection, _setTieredConnectionsForTest, _resetRpcProvider;
  beforeEach(async () => {
    const mod = await import("../../tools/rpc-provider.js");
    getConnection = mod.getConnection;
    _setTieredConnectionsForTest = mod._setTieredConnectionsForTest;
    _resetRpcProvider = mod._resetRpcProvider;
    _resetRpcProvider();
  });

  it("successive reads start at a rotating keyed provider (public still tried first)", async () => {
    const pub = { rpcEndpoint: "https://pub", getSlot: vi.fn().mockRejectedValue(new Error("429")) };
    const k0 = { rpcEndpoint: "https://k0", getSlot: vi.fn().mockResolvedValue(0) };
    const k1 = { rpcEndpoint: "https://k1", getSlot: vi.fn().mockResolvedValue(1) };
    const k2 = { rpcEndpoint: "https://k2", getSlot: vi.fn().mockResolvedValue(2) };
    _setTieredConnectionsForTest([pub], [k0, k1, k2], k0);

    // public fails (429) each call → answer comes from the rotated keyed start
    expect(await getConnection().getSlot()).toBe(0); // counter 0 → k0
    expect(await getConnection().getSlot()).toBe(1); // counter 1 → k1
    expect(await getConnection().getSlot()).toBe(2); // counter 2 → k2
    expect(await getConnection().getSlot()).toBe(0); // wraps → k0
    expect(pub.getSlot).toHaveBeenCalledTimes(4); // public always attempted first
  });

  it("still fails over across ALL keyed on transient errors (no reliability loss)", async () => {
    const k0 = { rpcEndpoint: "https://k0", getProgramAccounts: vi.fn().mockRejectedValue(new Error("503")) };
    const k1 = { rpcEndpoint: "https://k1", getProgramAccounts: vi.fn().mockRejectedValue(new Error("timeout")) };
    const k2 = { rpcEndpoint: "https://k2", getProgramAccounts: vi.fn().mockResolvedValue([{ ok: 1 }]) };
    _setTieredConnectionsForTest([], [k0, k1, k2], k0);

    const res = await getConnection().getProgramAccounts("p");
    expect(res).toEqual([{ ok: 1 }]);
    expect(k0.getProgramAccounts).toHaveBeenCalledTimes(1);
    expect(k1.getProgramAccounts).toHaveBeenCalledTimes(1);
    expect(k2.getProgramAccounts).toHaveBeenCalledTimes(1);
  });
});
