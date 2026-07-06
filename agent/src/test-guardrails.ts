// SUCCESS / FAIL / NULL test for the guardrail validator (no network). Run: npm run test:guardrails
import { validateOrders, sizeBuyQty, AGGRESSIVE_PAPER, STEADY_PAPER } from "./guardrails.js";
import type { OrderRequest } from "./alpaca.js";

const book = { equity: 100_000, openCount: 2 };
let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

// SUCCESS: a clean, in-limit buy with a stop.
const good: OrderRequest = { symbol: "AMD", side: "buy", qty: 50, type: "limit", limit_price: 150, est_price: 150, trail_percent: 18, thesis: "breakout" };
check("SUCCESS: clean buy validates", validateOrders([good], book)[0].ok === true);

// FAIL: oversized (60% of equity > 20% cap), and a separate one missing a stop, and a sub-$2 name.
const oversized: OrderRequest = { symbol: "TSLA", side: "buy", qty: 300, type: "market", est_price: 200, trail_percent: 18 };
check("FAIL: oversized position rejected", validateOrders([oversized], book)[0].ok === false);
const noStop: OrderRequest = { symbol: "NVDA", side: "buy", qty: 10, type: "market", est_price: 120 };
check("FAIL: buy without stop rejected", validateOrders([noStop], book)[0].reasons.some(r => /stop/.test(r)));
const penny: OrderRequest = { symbol: "XYZ", side: "buy", qty: 100, type: "market", est_price: 1.2, trail_percent: 18 };
check("FAIL: sub-$2 rejected", validateOrders([penny], book)[0].reasons.some(r => /quality floor/.test(r)));

// UNIVERSE: leveraged/inverse ETFs + crypto pairs are hard-rejected in code (not just prompt-excluded).
const lev: OrderRequest = { symbol: "SOXL", side: "buy", qty: 10, type: "market", est_price: 30, trail_percent: 18 };
check("FAIL: leveraged ETF (SOXL) rejected", validateOrders([lev], book)[0].reasons.some(r => /excluded universe: leveraged/.test(r)));
const bear: OrderRequest = { symbol: "GDXBEAR", side: "buy", qty: 10, type: "market", est_price: 30, trail_percent: 18 };
check("FAIL: leverage name-pattern (BEAR) rejected", validateOrders([bear], book)[0].reasons.some(r => /excluded universe: leveraged/.test(r)));
const cryptoSlash: OrderRequest = { symbol: "BTC/USD", side: "buy", qty: 0.1, type: "market", est_price: 60_000, trail_percent: 18 };
check("FAIL: crypto pair (BTC/USD) rejected", validateOrders([cryptoSlash], book)[0].reasons.some(r => /excluded universe: crypto/.test(r)));
const cryptoFlat: OrderRequest = { symbol: "ETHUSD", side: "buy", qty: 1, type: "market", est_price: 3000, trail_percent: 18 };
check("FAIL: crypto pair (ETHUSD) rejected", validateOrders([cryptoFlat], book)[0].reasons.some(r => /excluded universe: crypto/.test(r)));
const aapl: OrderRequest = { symbol: "AAPL", side: "buy", qty: 10, type: "market", est_price: 210, trail_percent: 18 };
check("SUCCESS: normal equity (AAPL) passes the universe check", validateOrders([aapl], book)[0].ok === true);

// NO COUNT CAP (CJ, 2026-07-06): Aggressive has NO maxOpen — a strategy-compliant buy is never rejected
// just for pushing the position COUNT up. Book already has 10 open; 5 more valid buys must ALL pass.
// (Risk/heat/name/sector/cash caps — the actual strategy — are enforced in risk-engine.riskGate + above.)
const bigBook = { equity: 100_000, openCount: 10 };
const manyBuys = Array.from({ length: 5 }, (_, i): OrderRequest => ({ symbol: `AA${i}`, side: "buy", qty: 1, type: "market", est_price: 50, trail_percent: 18 }));
{
  const v = validateOrders(manyBuys, bigBook, AGGRESSIVE_PAPER);
  check("NO-CAP: 10 open + 5 valid buys — none rejected on count (Aggressive)", v.every(x => x.ok === true));
  check("NO-CAP: no 'max open' reason appears anywhere", !v.some(x => x.reasons.some(r => /max .* open/.test(r))));
}

// maxOpen still enforced when a profile SETS it (Steady caps at 4): 3 open + 2 valid buys → 2nd rejected.
const noStopBuy = (s: string): OrderRequest => ({ symbol: s, side: "buy", qty: 1, type: "market", est_price: 50 });
const validBuy = (s: string): OrderRequest => ({ symbol: s, side: "buy", qty: 1, type: "market", est_price: 50, trail_percent: 18 });
{
  const v = validateOrders([validBuy("DD"), validBuy("EE")], { equity: 100_000, openCount: 3 }, STEADY_PAPER);
  check("CAP(steady): first buy fits (4th slot)", v[0].ok === true);
  check("CAP(steady): second buy exceeds maxOpen 4 → rejected", v[1].ok === false && v[1].reasons.some(r => /max 4 open/.test(r)));
}

// INVALID buys must NOT consume open slots: an order that fails another check is rejected + never placed,
// so it can't push later VALID buys over a set maxOpen. Steady book has 2 open; cap 4 → room for exactly
// 2 valid buys. The 3 leading invalid buys (no stop) must not bump the projected count.
const mixed = validateOrders([noStopBuy("AA"), noStopBuy("BB"), noStopBuy("CC"), validBuy("DD"), validBuy("EE")], { equity: 100_000, openCount: 2 }, STEADY_PAPER);
check("CAP: invalid buys are still rejected (missing stop)", mixed.slice(0, 3).every(v => v.ok === false));
check("CAP: invalid buys don't consume slots → both valid buys pass", mixed[3].ok === true && mixed[4].ok === true);
check("CAP: neither valid buy is mismarked as over-cap", !mixed[3].reasons.concat(mixed[4].reasons).some(r => /max .* open/.test(r)));

// sizeBuyQty: conviction-scaled position cap; fractional precision for the aggressive profile.
check("SIZE: full-conviction core takes the position cap", sizeBuyQty(100, 100_000, AGGRESSIVE_PAPER, 100) === 200);
check("SIZE: default conviction (100) = full cap", sizeBuyQty(100, 100_000, AGGRESSIVE_PAPER) === 200);
check("SIZE: lower conviction scales the size down (50 → half)", sizeBuyQty(100, 1000, AGGRESSIVE_PAPER, 50) === 1);
check("SIZE: fractional reaches a $900 name on a $1k book", sizeBuyQty(900, 1000, AGGRESSIVE_PAPER, 100) === 0.2222);
check("SIZE: a 50-conv satellite gets ~half a core", sizeBuyQty(900, 1000, AGGRESSIVE_PAPER, 50) === 0.1111);
check("SIZE: zero/invalid price or equity → 0", sizeBuyQty(0, 100_000, AGGRESSIVE_PAPER) === 0 && sizeBuyQty(100, 0, AGGRESSIVE_PAPER) === 0);

// NULL: empty proposal → empty result, no throw.
check("NULL: empty array → []", JSON.stringify(validateOrders([], book)) === "[]");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
