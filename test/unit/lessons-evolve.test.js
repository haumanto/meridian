// evolveThresholds() must only write keys that actually exist in config.
// Pre-fix it wrote maxVolatility (no such key) and minFeeTvlRatio
// (real key is minFeeActiveTvlRatio) — silent no-ops.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("evolveThresholds key correctness", () => {
  it("does not reference maxVolatility (was a no-op key)", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../lessons.js"), "utf8");
    // After the fix, the function should not write to maxVolatility at all
    expect(src).not.toMatch(/changes\.maxVolatility/);
    expect(src).not.toMatch(/screening\.maxVolatility\s*=/);
  });

  it("does not reference minFeeTvlRatio (real key is minFeeActiveTvlRatio)", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../lessons.js"), "utf8");
    // Both the variable name and the key should be the corrected form
    expect(src).not.toMatch(/\bminFeeTvlRatio\b/);
  });

  it("uses the correct minFeeActiveTvlRatio key", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../lessons.js"), "utf8");
    expect(src).toMatch(/minFeeActiveTvlRatio/);
  });
});
