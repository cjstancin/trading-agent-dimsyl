// Offline tests — v2 fixed-point decimal core. No network, no env.
import { d9, d9str, d9num, mul9, div9, allocate9, abs9, ONE9 } from "./v2/decimal.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

console.log("v2 decimal:");

// Parse + roundtrip
check("parse int", d9("5") === 5n * ONE9);
check("parse frac", d9("0.123456789") === 123456789n);
check("parse neg", d9("-2.5") === -25n * ONE9 / 10n);
check("roundtrip canonical", d9str(d9("12.340000000")) === "12.34");
check("roundtrip zero", d9str(0n) === "0");
check("roundtrip tiny", d9str(1n) === "0.000000001");
let threw = false;
try { d9("1.0000000001"); } catch { threw = true; }
check("rejects >9dp", threw);
threw = false;
try { d9("abc"); } catch { threw = true; }
check("rejects junk", threw);
threw = false;
try { d9(0.1 + 0.2); } catch { threw = true; } // 0.30000000000000004 → >9dp → must throw, not round
check("rejects float artifacts", threw);

// mul/div half-up
check("mul exact", d9str(mul9(d9("2.5"), d9("4"))) === "10");
check("mul qty×price", d9str(mul9(d9("0.123456789"), d9("100"))) === "12.3456789");
check("mul rounds half-up", mul9(1n, d9("0.5")) === 1n); // 0.0000000005 → rounds up to 1 unit
check("div exact", d9str(div9(d9("10"), d9("4"))) === "2.5");
check("div per-share", d9str(div9(d9("100"), d9("3"))) === "33.333333333");
check("neg mul sign", d9str(mul9(d9("-2"), d9("3"))) === "-6");
check("abs", abs9(d9("-1.5")) === d9("1.5"));

// allocate9 — exactness is the ledger's load-bearing property
const parts = allocate9(d9("100"), [d9("1"), d9("1"), d9("1")]);
check("allocate sums exactly", parts.reduce((a, b) => a + b, 0n) === d9("100"), parts.map(d9str).join(","));
check("allocate near-equal", parts.every((p) => abs9(p - d9("33.333333333")) <= 1n));
// Adversarial loop: random-ish weights must always sum exactly
let exact = true;
for (let i = 1; i < 50; i++) {
  const total = d9(String(i)) + BigInt(i * 7919); // awkward remainders
  const ws = [d9(String(i)), d9("0.000000123") * BigInt(i), d9(String(101 - i * 2 > 0 ? 101 - i * 2 : 1))];
  const ps = allocate9(total, ws);
  if (ps.reduce((a, b) => a + b, 0n) !== total) { exact = false; break; }
}
check("allocate exact over 50 awkward cases", exact);
check("allocate negative total", allocate9(d9("-10"), [d9("1"), d9("2")]).reduce((a, b) => a + b, 0n) === d9("-10"));
check("d9num display", Math.abs(d9num(d9("1.5")) - 1.5) < 1e-12);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("v2 decimal: all green");
