// Bull v2 — fixed-point decimal math. The tax ledger's contract is "9-dp decimal quantities, never
// float" (design §7): Alpaca reports fractional fills like "0.123456789" and float math on those
// accumulates basis errors that a 1099-B reconciliation would surface as phantom cents. Everything
// money- or quantity-shaped in v2 is a bigint scaled by 1e9 ("d9"), serialized as a decimal STRING at
// the edges (DB rows store strings; JSON never sees a bigint). Parsing is pure string math — no
// parseFloat anywhere on a broker-reported number.
const SCALE = 9;
export const ONE9 = 10n ** BigInt(SCALE); // 1.000000000

export type D9 = bigint;

/** Parse a decimal string (or integer) into d9. Throws on junk — a malformed broker number must
 *  halt the caller, not silently become 0. Accepts optional sign, up to 9 fractional digits
 *  (extra digits are an error, not a rounding: Alpaca never reports more than 9). */
export function d9(s: string | number | bigint): D9 {
  if (typeof s === "bigint") return s * ONE9;
  const str = typeof s === "number" ? numToStr(s) : String(s).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(str);
  if (!m) throw new Error(`d9: unparseable decimal "${str}"`);
  const [, sign, whole, fracRaw] = m;
  const frac = fracRaw ?? "";
  if (frac.length > SCALE) throw new Error(`d9: more than ${SCALE} decimal places in "${str}"`);
  const v = BigInt(whole) * ONE9 + BigInt(frac.padEnd(SCALE, "0"));
  return sign === "-" ? -v : v;
}

/** Number → exact decimal string. Only for HUMAN-entered config numbers (e.g. 0.4, 25) that are
 *  exactly representable; throws if the number needs scientific notation or >9 dp. */
function numToStr(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`d9: non-finite number ${n}`);
  const s = String(n);
  if (/e/i.test(s)) throw new Error(`d9: scientific notation not supported (${s})`);
  return s;
}

/** d9 → canonical decimal string (no trailing zeros beyond what's needed, always at least "0"). */
export function d9str(v: D9): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / ONE9;
  const frac = (abs % ONE9).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** d9 → JS number (display/telemetry ONLY — never feed back into ledger math). */
export function d9num(v: D9): number {
  return Number(v) / Number(ONE9);
}

/** Multiply two d9 values (e.g. qty × price → dollars), round HALF-UP at the 9th dp.
 *  Half-up (not truncation) so a 0.0000000005 doesn't systematically leak basis. */
export function mul9(a: D9, b: D9): D9 {
  const p = a * b;
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const q = (abs + ONE9 / 2n) / ONE9;
  return neg ? -q : q;
}

/** Divide a by b in d9 space (e.g. dollars ÷ qty → per-share), round HALF-UP at the 9th dp. */
export function div9(a: D9, b: D9): D9 {
  if (b === 0n) throw new Error("div9: division by zero");
  const num = a * ONE9;
  const neg = (num < 0n) !== (b < 0n);
  const absNum = num < 0n ? -num : num;
  const absDen = b < 0n ? -b : b;
  const q = (absNum + absDen / 2n) / absDen;
  return neg ? -q : q;
}

export const min9 = (a: D9, b: D9): D9 => (a < b ? a : b);
export const max9 = (a: D9, b: D9): D9 => (a > b ? a : b);
export const abs9 = (v: D9): D9 => (v < 0n ? -v : v);

/** Allocate `total` across `weights` proportionally with NO residue: each share is floored, then the
 *  leftover d9-units go one at a time to the largest fractional remainders (deterministic — ties break
 *  by lowest index). Used to split a disposal's basis/proceeds across lots so the parts always sum
 *  EXACTLY to the whole — the property a FIFO tax ledger lives or dies on. */
export function allocate9(total: D9, weights: D9[]): D9[] {
  if (weights.length === 0) return [];
  const wsum = weights.reduce((a, b) => a + b, 0n);
  if (wsum === 0n) throw new Error("allocate9: zero total weight");
  const neg = total < 0n;
  const absTotal = neg ? -total : total;
  const shares = weights.map((w) => (absTotal * w) / wsum); // floored
  let leftover = absTotal - shares.reduce((a, b) => a + b, 0n);
  // Distribute leftover units by largest remainder, ties by index (stable + deterministic).
  const rems = weights.map((w, i) => ({ i, rem: (absTotal * w) % wsum }));
  rems.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem < b.rem ? 1 : -1));
  for (let k = 0; leftover > 0n; k = (k + 1) % rems.length) {
    shares[rems[k].i] += 1n;
    leftover -= 1n;
  }
  return neg ? shares.map((s) => -s) : shares;
}
