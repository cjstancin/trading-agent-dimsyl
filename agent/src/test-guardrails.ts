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

// FAIL: exceeding max open. AGGRESSIVE_PAPER caps at 8; book already has 2 open, so 7 new buys → 9 > 8.
const overMax = Array.from({ length: 7 }, (_, i): OrderRequest => ({ symbol: `AA${i}`, side: "buy", qty: 1, type: "market", est_price: 50, trail_percent: 18 }));
check("FAIL: max-open exceeded once projected open passes the cap", validateOrders(overMax, book).some(v => v.reasons.some(r => /max .* open/.test(r))));

// INVALID buys must NOT consume open slots: an order that fails another check is rejected + never placed,
// so it can't push later VALID buys over maxOpen. Book has 6 open; cap is 8 → room for exactly 2 valid buys.
// The 3 leading invalid buys (no stop) used to each bump the projected count, wrongly rejecting both valids.
const capBook = { equity: 100_000, openCount: 6 };
const noStopBuy = (s: string): OrderRequest => ({ symbol: s, side: "buy", qty: 1, type: "market", est_price: 50 });
const validBuy = (s: string): OrderRequest => ({ symbol: s, side: "buy", qty: 1, type: "market", est_price: 50, trail_percent: 18 });
const mixed = validateOrders([noStopBuy("AA"), noStopBuy("BB"), noStopBuy("CC"), validBuy("DD"), validBuy("EE")], capBook);
check("CAP: invalid buys are still rejected (missing stop)", mixed.slice(0, 3).every(v => v.ok === false));
check("CAP: invalid buys don't consume slots → both valid buys pass", mixed[3].ok === true && mixed[4].ok === true);
check("CAP: neither valid buy is mismarked as over-cap", !mixed[3].reasons.concat(mixed[4].reasons).some(r => /max .* open/.test(r)));

// NULL: empty proposal → empty result, no throw.
check("NULL: empty array → []", JSON.stringify(validateOrders([], book)) === "[]");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
