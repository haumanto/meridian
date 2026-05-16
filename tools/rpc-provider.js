// Multi-provider RPC factory — two tiers:
//
//   - PUBLIC tier (keyless, RPC_URLS_PUBLIC / user-config rpcUrlsPublic):
//     tried FIRST for whitelisted idempotent reads, to save paid-RPC
//     credits. Reads are the credit driver (getProgramAccounts,
//     getMultipleAccountsInfo, simulateTransaction, …).
//   - KEYED tier (RPC_URLS / rpcUrls, else RPC_URL): the reliable/paid
//     endpoints. Used as read FALLBACK, and pinned as the SOLE target
//     for transaction sends + every non-read method.
//
// Read order  = [...public, ...keyed]  (public-first, keyed fallback).
// Send target = first keyed connection (never public — public RPCs land
//   memecoin tx poorly; mid-tx failover risks double-deploy/close). If no
//   keyed tier is configured, sends degrade to the first read conn + warn.
//
// No public tier + single RPC_URL/rpcUrls → behaves exactly as before
// (one list; reads and sends both use it). Fully backward compatible.

import { Connection } from "@solana/web3.js";
import { log } from "../logger.js";

// Idempotent read methods safe to retry on an alternate provider.
// Anything NOT here (sendRawTransaction, sendTransaction,
// sendAndConfirmTransaction, requestAirdrop, …) never failovers and
// always targets the keyed send connection.
const FAILOVER_READS = new Set([
  "getAccountInfo",
  "getParsedAccountInfo",
  "getMultipleAccountsInfo",
  "getProgramAccounts",
  "getLatestBlockhash",
  "getBalance",
  "getSignatureStatus",
  "getSignatureStatuses",
  "simulateTransaction",
  "getSlot",
  "getBlockHeight",
  "getTransaction",
  "getParsedTransaction",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getParsedTokenAccountsByOwner",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "getRecentPrioritizationFees",
]);

function splitCsv(v) {
  if (!v) return [];
  const seen = new Set();
  const out = [];
  for (const raw of String(v).split(",")) {
    const s = (raw || "").trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function resolvePublicUrls() {
  return splitCsv(process.env.RPC_URLS_PUBLIC);
}

function resolveKeyedUrls() {
  if (process.env.RPC_URLS) return splitCsv(process.env.RPC_URLS);
  if (process.env.RPC_URL) return [process.env.RPC_URL.trim()];
  return [];
}

// Transient = worth trying the next provider. Mirrors fetch-retry.js's
// taxonomy plus web3.js's stringly-typed network errors.
function isTransient(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  const code = err.code;
  if (code === "ECONNRESET" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "EAI_AGAIN") {
    return true;
  }
  // Endpoint structurally can't serve this method (free-tier / plan gate /
  // method-not-found). Idempotent reads → safe to retry on the keyed tier.
  // dRPC free-tier method block = JSON-RPC code 35; -32601 = method not found.
  if (code === 35 || code === -32601) return true;
  const status = Number(err.status);
  if (status === 429 || status === 402 || (status >= 500 && status < 600)) return true;
  const msg = String(err.message || err).toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("socket hang up") ||
    msg.includes("network error") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("service unavailable") ||
    msg.includes("bad gateway") ||
    // Provider plan/tier restrictions — the next provider may support it.
    msg.includes("freetier") ||
    msg.includes("free tier") ||
    msg.includes("paid tier") ||
    msg.includes("upgrade to paid") ||
    msg.includes("requires a paid") ||
    msg.includes("payment required") ||
    msg.includes("method is not available") ||
    msg.includes("method not found") ||
    msg.includes("not supported on") ||
    msg.includes("plan does not")
  );
}

let _readConns = null; // Connection[] — public-first, keyed fallback
let _sendConn = null; // Connection — keyed only (or degraded)
let _proxy = null;

function hostOf(conn) {
  try {
    return new URL(conn.rpcEndpoint).host;
  } catch {
    return "rpc";
  }
}

function build() {
  const publicUrls = resolvePublicUrls();
  const keyedUrls = resolveKeyedUrls();

  // One Connection per unique URL, shared between read list and send target.
  const byUrl = new Map();
  const conn = (u) => {
    if (!byUrl.has(u)) byUrl.set(u, new Connection(u, "confirmed"));
    return byUrl.get(u);
  };

  // Read order: public first, then keyed; dedupe preserving first occurrence.
  const seen = new Set();
  const readConns = [];
  for (const u of [...publicUrls, ...keyedUrls]) {
    if (seen.has(u)) continue;
    seen.add(u);
    readConns.push(conn(u));
  }

  let sendConn;
  if (keyedUrls.length > 0) {
    sendConn = conn(keyedUrls[0]);
  } else if (readConns.length > 0) {
    sendConn = readConns[0];
    log("rpc", `WARN no keyed RPC configured — sends will use ${hostOf(sendConn)} (set RPC_URLS for a reliable send endpoint)`);
  } else {
    // No config at all — preserve legacy `new Connection(undefined)` behavior;
    // validateBoot surfaces the real error at startup.
    sendConn = new Connection(process.env.RPC_URL, "confirmed");
    readConns.push(sendConn);
  }

  log(
    "rpc",
    `Multi-provider RPC: ${publicUrls.length} public + ${keyedUrls.length} keyed — reads public-first, sends keyed (${hostOf(sendConn)})`,
  );

  return { readConns, sendConn };
}

function ensure() {
  if (!_readConns) {
    const { readConns, sendConn } = build();
    _readConns = readConns;
    _sendConn = sendConn;
  }
}

function makeFailoverMethod(method) {
  return async function (...args) {
    ensure();
    const conns = _readConns;
    let lastErr;
    for (let i = 0; i < conns.length; i++) {
      try {
        return await conns[i][method](...args);
      } catch (err) {
        lastErr = err;
        const more = i < conns.length - 1;
        if (more && isTransient(err)) {
          log(
            "rpc",
            `failover ${hostOf(conns[i])}→${hostOf(conns[i + 1])} on ${method}(): ${String(err.message || err).slice(0, 120)}`,
          );
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };
}

const _methodCache = new Map();

export function getConnection() {
  if (_proxy) return _proxy;
  _proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "string" && FAILOVER_READS.has(prop)) {
          let fn = _methodCache.get(prop);
          if (!fn) {
            fn = makeFailoverMethod(prop);
            _methodCache.set(prop, fn);
          }
          return fn;
        }
        // Sends + every non-read method + property access → keyed send
        // connection, no failover (avoids double-deploy/close hazard).
        ensure();
        const target = _sendConn;
        const val = target[prop];
        return typeof val === "function" ? val.bind(target) : val;
      },
    },
  );
  return _proxy;
}

// Test-only: drop cached state so a fresh env is picked up.
export function _resetRpcProvider() {
  _readConns = null;
  _sendConn = null;
  _proxy = null;
  _methodCache.clear();
}

// Test-only: inject fake Connection-shaped objects.
//   readConns: array tried in order for whitelisted reads
//   sendConn:  target for sends/non-read (defaults to readConns[0])
export function _setConnectionsForTest(readConns, sendConn) {
  _readConns = readConns;
  _sendConn = sendConn ?? readConns[0];
  _proxy = null;
  _methodCache.clear();
}

// Test-only: expose the transient classifier.
export const _isTransient = isTransient;
