import {
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { log } from "../logger.js";
import { config } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { getConnection } from "./rpc-provider.js";

let _wallet = null;
// getConnection() is imported from ./rpc-provider.js (multi-provider
// failover for idempotent reads; sends pinned to primary).

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

const ZERO_BALANCES = (wallet, error) => ({
  wallet, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error,
});

// SPL Token + Token-2022 program ids come from @solana/spl-token (already
// PublicKey instances) — the RPC fallback queries both so Token-2022
// holdings aren't silently dropped vs the Helius enriched response.

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens.
 * Primary provider = Helius enriched Wallet API; on failure (or when
 * config.wallet.balanceProvider === "rpc") falls back to a provider-
 * agnostic path derived from standard JSON-RPC + Jupiter pricing, so
 * Helius is no longer a single point of failure. Return shape is
 * identical across both paths (6+ callers + dashboard + LLM depend on it).
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return ZERO_BALANCES(null, "Wallet not configured");
  }

  const provider = config.wallet?.balanceProvider === "rpc" ? "rpc" : "helius";

  if (provider === "rpc") {
    return fetchBalancesFromRpc(walletAddress);
  }

  // helius primary, RPC-derived fallback
  try {
    const res = await fetchBalancesHelius(walletAddress);
    if (res.error) throw new Error(res.error);
    return res;
  } catch (error) {
    log("wallet_warn", `Helius balances failed — using RPC-derived fallback: ${error.message}`);
    const fb = await fetchBalancesFromRpc(walletAddress);
    if (fb.error) log("wallet_error", `RPC-derived balance fallback also failed: ${fb.error}`);
    return fb;
  }
}

// ─── Primary: Helius enriched Wallet API (unchanged behavior) ────────
async function fetchBalancesHelius(walletAddress) {
  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    return ZERO_BALANCES(walletAddress, "Helius API key missing");
  }
  try {
    const base = process.env.HELIUS_BALANCES_URL || "https://api.helius.xyz/v1/wallet";
    const url = `${base.replace(/\/+$/, "")}/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    // Hot path — runs every management cycle. Retry on 429/5xx, 8s timeout per attempt.
    const res = await fetchWithRetry(url, {}, { timeoutMs: 8_000, retries: 3 });
    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const balances = data.balances || [];

    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return ZERO_BALANCES(walletAddress, error.message);
  }
}

// Tolerant Jupiter price extractor — v3 is a flat map keyed by mint
// ({ <mint>: { usdPrice } }); older shapes nest under data / use price.
// Returns a finite number or null (null → usd omitted, same as Helius).
function priceFromJupiter(json, mint) {
  const cand =
    json?.[mint]?.usdPrice ?? json?.[mint]?.price ??
    json?.data?.[mint]?.usdPrice ?? json?.data?.[mint]?.price;
  const n = Number(cand);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchJupiterPrices(mints) {
  const ids = [...new Set(mints.filter(Boolean))];
  if (!ids.length) return {};
  try {
    const url = `${JUPITER_PRICE_API}?ids=${ids.join(",")}`;
    const key = getJupiterApiKey();
    const res = await fetchWithRetry(
      url, { headers: key ? { "x-api-key": key } : {} },
      { timeoutMs: 8_000, retries: 2 },
    );
    if (!res.ok) return {};
    const json = await res.json();
    const out = {};
    for (const m of ids) out[m] = priceFromJupiter(json, m);
    return out;
  } catch {
    return {};
  }
}

// Pure: assemble the exact getWalletBalances shape from raw RPC data.
// `tokenAccounts` = array of {mint, uiAmount} (parsed). `priceByMint` =
// { mint: usdNumber|null }. Exported for unit testing (no network).
export function assembleBalancesFromRpc({ lamports, tokenAccounts, priceByMint, walletAddress }) {
  const SOL = config.tokens.SOL;
  const USDC = config.tokens.USDC;
  const solBalance = (Number(lamports) || 0) / LAMPORTS_PER_SOL;
  const solPrice = priceByMint?.[SOL] ?? 0;
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // Collapse duplicate token accounts of the same mint.
  const byMint = new Map();
  for (const t of tokenAccounts || []) {
    if (!t?.mint) continue;
    byMint.set(t.mint, (byMint.get(t.mint) || 0) + (Number(t.uiAmount) || 0));
  }

  const tokens = [];
  let tokensUsd = 0;
  let usdcBalance = 0;
  for (const [mint, balance] of byMint) {
    if (mint === USDC) usdcBalance = balance;
    const px = priceByMint?.[mint];
    const usd = px != null ? round2(balance * px) : null;
    if (usd != null) tokensUsd += usd;
    tokens.push({ mint, symbol: mint.slice(0, 8), balance, usd });
  }

  const solUsd = round2(solBalance * solPrice);
  return {
    wallet: walletAddress,
    sol: Math.round(solBalance * 1e6) / 1e6,
    sol_price: round2(solPrice),
    sol_usd: solUsd,
    usdc: round2(usdcBalance),
    tokens,
    total_usd: round2(solUsd + tokensUsd),
  };
}

// ─── Fallback: standard JSON-RPC + Jupiter pricing ───────────────────
// Uses getConnection() (public-first → keyed failover; idempotent reads,
// no double-spend hazard). Provider-agnostic — survives a Helius outage.
async function fetchBalancesFromRpc(walletAddress) {
  try {
    const connection = getConnection();
    const owner = new PublicKey(walletAddress);
    const [lamports, splAccs, t22Accs] = await Promise.all([
      connection.getBalance(owner),
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] })),
    ]);
    const tokenAccounts = [...(splAccs?.value || []), ...(t22Accs?.value || [])]
      .map((acc) => {
        const info = acc?.account?.data?.parsed?.info;
        const amt = info?.tokenAmount;
        const ui = amt?.uiAmount ?? (amt?.amount != null && amt?.decimals != null
          ? Number(amt.amount) / 10 ** Number(amt.decimals) : 0);
        return info?.mint ? { mint: info.mint, uiAmount: Number(ui) || 0 } : null;
      })
      .filter((t) => t && t.uiAmount > 0);

    const priceByMint = await fetchJupiterPrices([config.tokens.SOL, ...tokenAccounts.map((t) => t.mint)]);
    return assembleBalancesFromRpc({ lamports, tokenAccounts, priceByMint, walletAddress });
  } catch (error) {
    log("wallet_error", `RPC-derived balances failed: ${error.message}`);
    return ZERO_BALANCES(walletAddress, error.message);
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
