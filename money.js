// Canonical money renderer — SOL is the base unit, USD is the secondary
// in parens. Whichever side is *derived* (converted at the current SOL
// price rather than a recorded native value) is prefixed "≈". Used
// everywhere the agent shows money (Telegram, briefing, cycle reports,
// commands) so the denomination is consistent. Pure, no I/O.
//
//   solMode close (both native): "+◎0.0840 (+$7.30)"
//   historical USD-only:         "≈ ◎0.69 ($60.14)"
//   deploy (native SOL only):    "◎0.30 (≈ $26.00)"
//   only one side, no price:     "◎0.30"  /  "$60.14"

const fin = (n) => n != null && n !== "" && Number.isFinite(Number(n));

/**
 * @param {number|null} usd   exact USD value, or null if unknown
 * @param {object} o
 * @param {number|null} [o.sol] exact native SOL value, or null
 * @param {number}      [o.solPrice] current SOL/USD price (for the derived side)
 * @param {boolean}     [o.signed] force a leading +/- (PnL/deltas)
 * @returns {string}
 */
export function fmtMoney(usd, { sol = null, solPrice = 0, signed = false } = {}) {
  const hasUsd = fin(usd);
  const hasSol = fin(sol);
  const px = fin(solPrice) && Number(solPrice) > 0 ? Number(solPrice) : 0;

  let solV = hasSol ? Number(sol) : (hasUsd && px ? Number(usd) / px : null);
  let usdV = hasUsd ? Number(usd) : (hasSol && px ? Number(sol) * px : null);
  if (solV == null && usdV == null) return "—";

  const solDerived = !hasSol && solV != null; // converted from USD
  const usdDerived = !hasUsd && usdV != null; // converted from SOL
  const sgn = (n) => (signed ? (n >= 0 ? "+" : "-") : (n < 0 ? "-" : ""));
  const abs = (n) => Math.abs(n);

  const solStr = solV == null ? null : `${solDerived ? "≈ " : ""}${sgn(solV)}◎${abs(solV).toFixed(4)}`;
  const usdStr = usdV == null ? null : `${usdDerived ? "≈ " : ""}${sgn(usdV)}$${abs(usdV).toFixed(2)}`;
  if (solStr && usdStr) return `${solStr} (${usdStr})`;
  return solStr || usdStr;
}
