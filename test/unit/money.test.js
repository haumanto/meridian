// fmtMoney is the one renderer behind every money figure the agent
// shows. SOL is the base, USD secondary in parens, "≈" marks the
// converted side. Pure — no isolation needed.
import { describe, it, expect } from "vitest";
import { fmtMoney } from "../../money.js";

describe("fmtMoney — SOL base, USD secondary, ≈ on derived side", () => {
  it("both native exact (solMode close) → no ≈", () => {
    expect(fmtMoney(7.30, { sol: 0.0840, signed: true })).toBe("+◎0.0840 (+$7.30)");
    expect(fmtMoney(-7.3, { sol: -0.084, signed: true })).toBe("-◎0.0840 (-$7.30)");
  });
  it("USD-only + price → SOL derived (≈ on SOL)", () => {
    expect(fmtMoney(60.14, { solPrice: 86.79 })).toBe("≈ ◎0.6929 ($60.14)");
  });
  it("native SOL only + price → USD derived (≈ on USD)", () => {
    expect(fmtMoney(null, { sol: 0.3, solPrice: 86.79 })).toBe("◎0.3000 (≈ $26.04)");
  });
  it("single side, no price → just that side, no ≈", () => {
    expect(fmtMoney(null, { sol: 0.3 })).toBe("◎0.3000");
    expect(fmtMoney(60.14, {})).toBe("$60.14");
  });
  it("signed zero/positive prefix only when signed", () => {
    expect(fmtMoney(5, {})).toBe("$5.00");
    expect(fmtMoney(5, { signed: true })).toBe("+$5.00");
  });
  it("nothing usable → em dash", () => {
    expect(fmtMoney(null, {})).toBe("—");
    expect(fmtMoney(NaN, { sol: NaN })).toBe("—");
  });
  it("zero price is ignored (no divide-by-zero / no fake conversion)", () => {
    expect(fmtMoney(60.14, { solPrice: 0 })).toBe("$60.14");
  });
});
