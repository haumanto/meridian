// Multi-provider RPC factory — Helius primary + fallback(s).
//
// Resolves an ordered URL list from RPC_URLS (comma-separated) or falls
// back to the single RPC_URL. Builds one Connection per URL and returns a
// Proxy:
//
//   - Whitelisted idempotent READS  → try providers in order; on a
//     transient error advance to the next provider. Re-reading global
//     chain state on any full node is idempotent, so this is safe.
//   - Everything else (incl. all send*/transaction methods, and any
//     property access) → delegate to the PRIMARY (providers[0]) with NO
//     failover. Pinning the send+confirm lifecycle to one provider avoids
//     the double-deploy / double-close hazard of mid-tx failover.
//
// Single-URL configs get a 1-element list and the failover path is never
// exercised — fully backward compatible.

import { Connection } from "@solana/web3.js";
import { log } from "../logger.js";

// Idempotent read methods that are safe to retry on an alternate provider.
// Anything NOT in this set (sendRawTransaction, sendTransaction,
// sendAndConfirmTransaction, requestAirdrop, …) never failovers.
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
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "getRecentPrioritizationFees",
]);

function resolveUrls() {
  const list = process.env.RPC_URLS
    ? process.env.RPC_URLS.split(",")
    : process.env.RPC_URL
      ? [process.env.RPC_URL]
      : [];
  // trim, drop empties, dedupe (preserve order)
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = (raw || "").trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
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
  const status = Number(err.status);
  if (status === 429 || (status >= 500 && status < 600)) return true;
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
    msg.includes("bad gateway")
  );
}

let _connections = null; // Connection[]
let _proxy = null;

function buildConnections() {
  const urls = resolveUrls();
  if (urls.length === 0) {
    // Defer the hard failure to validateBoot / first use; keep parity
    // with the old `new Connection(undefined)` behavior.
    return [new Connection(process.env.RPC_URL, "confirmed")];
  }
  const conns = urls.map((u) => new Connection(u, "confirmed"));
  if (conns.length > 1) {
    log("rpc", `Multi-provider RPC: ${conns.length} endpoints (primary + ${conns.length - 1} fallback)`);
  }
  return conns;
}

function connections() {
  if (!_connections) _connections = buildConnections();
  return _connections;
}

function hostOf(conn) {
  try {
    return new URL(conn.rpcEndpoint).host;
  } catch {
    return "rpc";
  }
}

function makeFailoverMethod(method) {
  return async function (...args) {
    const conns = connections();
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
  const primary = () => connections()[0];
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
        // Everything else (send*, properties, internals) → primary, no failover.
        const target = primary();
        const val = target[prop];
        return typeof val === "function" ? val.bind(target) : val;
      },
    },
  );
  return _proxy;
}

// Test-only: drop cached connections/proxy so a fresh env is picked up.
export function _resetRpcProvider() {
  _connections = null;
  _proxy = null;
  _methodCache.clear();
}

// Test-only: inject fake Connection-shaped objects to exercise failover
// without real network. Pass an array; index 0 is primary.
export function _setConnectionsForTest(arr) {
  _connections = arr;
  _proxy = null;
  _methodCache.clear();
}

// Test-only: expose the transient classifier.
export const _isTransient = isTransient;
