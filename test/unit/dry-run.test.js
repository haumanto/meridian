// Dry-run integrity: every write-side tool must check DRY_RUN before
// signing a transaction. We verify by source-level inspection rather than
// executing the tool (executing requires loading the Solana SDK + RPC
// client which adds ~5s per import).

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const root = path.resolve(import.meta.dirname, "../..");
const dlmmSrc = fs.readFileSync(path.join(root, "tools/dlmm.js"), "utf8");
const walletSrc = fs.readFileSync(path.join(root, "tools/wallet.js"), "utf8");

function fnBody(src, fnName) {
  // Match `export ... function fnName(...) { ... }` to its closing brace at depth 0.
  // Allow multiline destructured params (deployPosition takes a multi-line object).
  const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${fnName}\\s*\\([\\s\\S]*?\\)\\s*{`, "m");
  const m = re.exec(src);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

describe("DRY_RUN integrity (source-level)", () => {
  it("claimFees checks DRY_RUN before sending", () => {
    const body = fnBody(dlmmSrc, "claimFees");
    expect(body).not.toBeNull();
    expect(body).toMatch(/DRY_RUN[^]*===[^]*"true"/);
    expect(body.indexOf("DRY_RUN")).toBeLessThan(body.indexOf("sendAndConfirmTransaction"));
  });

  it("closePosition checks DRY_RUN before sending", () => {
    const body = fnBody(dlmmSrc, "closePosition");
    expect(body).not.toBeNull();
    expect(body).toMatch(/DRY_RUN[^]*===[^]*"true"/);
  });

  it("deployPosition checks DRY_RUN before sending", () => {
    const body = fnBody(dlmmSrc, "deployPosition");
    expect(body).not.toBeNull();
    expect(body).toMatch(/DRY_RUN[^]*===[^]*"true"/);
  });

  it("swapToken checks DRY_RUN before sending", () => {
    const body = fnBody(walletSrc, "swapToken");
    expect(body).not.toBeNull();
    expect(body).toMatch(/DRY_RUN[^]*===[^]*"true"/);
  });
});
