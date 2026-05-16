// Pure decision logic for the autoresearch startup guard. No process
// exit, no env mutation, no logging — the caller (index.js) applies the
// verdict. Mirrors the testable-helper pattern of whale-detector.js /
// strategy-selector.js / confidence-sizing.js.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// Derive a base58 Solana pubkey from a base58 secret key — the exact
// scheme tools/wallet.js getWallet() uses. Throws on bad input.
export function deriveSolPubkey(secret) {
  return Keypair.fromSecretKey(bs58.decode(secret)).publicKey.toBase58();
}

/**
 * @param {{ env: Record<string,string|undefined>, paths: {root:string,dataDir:string}, config: {autoresearch?:{maxWalletSol?:number,dailyLossLimitSol?:number}} }} args
 * @returns {{profile:false}
 *   | {profile:true, ok:false, error:string}
 *   | {profile:true, ok:true, walletKey:string, pubkey:string, logMsg:string}}
 */
export function evaluateAutoresearchGuard({ env, paths, config }) {
  if (env.MERIDIAN_PROFILE !== "autoresearch") return { profile: false };

  const abort = (error) => ({ profile: true, ok: false, error });
  const prodKey = env.WALLET_PRIVATE_KEY;
  const arKey = env.AUTORESEARCH_WALLET_PRIVATE_KEY;
  const ar = (config && config.autoresearch) || {};

  if (!env.MERIDIAN_DATA_DIR)
    return abort("MERIDIAN_DATA_DIR is not set — profile isolation is required.");
  if (paths.dataDir === paths.root)
    return abort("MERIDIAN_DATA_DIR resolves to the project root — autoresearch must use an isolated subdirectory.");
  if (!arKey)
    return abort("AUTORESEARCH_WALLET_PRIVATE_KEY is not set — the autoresearch instance needs its own separate wallet.");

  let arPub;
  try {
    arPub = deriveSolPubkey(arKey);
  } catch {
    return abort("AUTORESEARCH_WALLET_PRIVATE_KEY is not a valid base58 secret key.");
  }
  if (prodKey) {
    let prodPub = null;
    try { prodPub = deriveSolPubkey(prodKey); } catch { /* prod key shape irrelevant if it won't decode */ }
    if (prodPub && prodPub === arPub)
      return abort("Autoresearch wallet equals the production wallet — refusing to trade production funds in an experiment.");
  }

  if (!(Number.isFinite(ar.maxWalletSol) && ar.maxWalletSol > 0))
    return abort("autoresearch.maxWalletSol must be a positive number — the AR instance refuses to run uncapped.");
  if (!(Number.isFinite(ar.dailyLossLimitSol) && ar.dailyLossLimitSol > 0))
    return abort("autoresearch.dailyLossLimitSol must be a positive number — the AR instance refuses to run uncapped.");

  return {
    profile: true,
    ok: true,
    walletKey: arKey,
    pubkey: arPub,
    logMsg: `[autoresearch] guard passed — isolated data dir ${paths.dataDir}, wallet ${arPub.slice(0, 4)}…${arPub.slice(-4)}, caps maxWalletSol=${ar.maxWalletSol} dailyLossLimitSol=${ar.dailyLossLimitSol}`,
  };
}
