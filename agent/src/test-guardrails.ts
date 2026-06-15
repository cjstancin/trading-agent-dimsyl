// SUCCESS / FAIL / NULL test for the guardrail validator (no network). Run: npm run test:guardrails
import { validateOrders, AGGRESSIVE_PAPER } from "./guardrails.js";
import type { OrderRequest } from "./alpaca.js";

const book = { equity: 100_000, openCount: 2 };
let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

// SUCCESS: a clean, in-limit buy with a stop.
const good: OrderRequest = { symbol: "AMD", side: "buy", qty: 50, type: "limit", limit_price: 150, est_price: 150, trail_percent: 18, thesis: "breakout" };
check("SUCCESS: clean buy validates", validateOrders([good], book)[0].ok === true);

// FAIL: oversized (60% of equity > 40%), and a separate one missing a stop, and a sub-$2 name.
const oversized: OrderRequest = { symbol: "TSLA", side: "buy", qty: 300, type: "market", est_price: 200, trail_percent: 18 };
check("FAIL: oversized position rejected", validateOrders([oversized], book)[0].ok === false);
const noStop: OrderRequest = { symbol: "NVDA", side: "buy", qty: 10, type: "market", est_price: 120 };
check("FAIL: buy without stop rejected", validateOrders([noStop], book)[0].reasons.some(r => /stop/.test(r)));
const penny: OrderRequest = { symbol: "XYZ", side: "buy", qty: 100, type: "market", est_price: 1.2, trail_percent: 18 };
check("FAIL: sub-$2 rejected", validateOrders([penny], book)[0].reasons.some(r => /quality floor/.test(r)));

// FAIL: exceeding max open (book already 2 open; 5 new buys → 7 > 6)
const five = Array.from({ length: 5 }, (_, i): OrderRequest => ({ symbol: `AA${i}`, side: "buy", qty: 1, type: "market", est_price: 50, trail_percent: 18 }));
check("FAIL: max-open exceeded on the 5th", validateOrders(five, book).some(v => v.reasons.some(r => /max .* open/.test(r))));

// NULL: empty proposal → empty result, no throw.
check("NULL: empty array → []", JSON.stringify(validateOrders([], book)) === "[]");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
