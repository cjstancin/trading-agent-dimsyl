// Tests for the deterministic risk engine (no network). Run: npm run test:risk-engine
import { inverseVolWeights, volTargetLeverage, fractionalKelly, sizeByRisk, chandelierStop, atrStop, riskGate, bookRoom, regimeOn, atrFromBars, DEFAULT_RISK } from "./risk-engine.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// inverse-vol weights: lower vol → larger weight; sum to 1
{
  const w = inverseVolWeights([10, 20, 40]);
  check("inverseVol: lower vol gets the biggest weight", w[0] > w[1] && w[1] > w[2]);
  check("inverseVol: weights sum to 1", near(w[0] + w[1] + w[2], 1));
}

// vol-target leverage: target/realized, capped at maxLeverage (1.0 cash account)
check("volTarget: scales down in high vol (15/30=0.5)", near(volTargetLeverage(30), 0.5));
check("volTarget: capped at maxLeverage in low vol", near(volTargetLeverage(10), 1));

// fractional Kelly: half of full Kelly; negative → 0
check("fractionalKelly: 0.4 full → 0.2 (half)", near(fractionalKelly(0.4), 0.2));
check("fractionalKelly: negative edge → 0", fractionalKelly(-0.1) === 0);

// risk-based sizing: 1% risk ÷ stop distance, capped by per-name 20%
check("sizeByRisk: risk-budget binds (10000,$100,stop$90 @1.5% → 15 sh)", sizeByRisk(10000, 100, 90) === 15);
check("sizeByRisk: per-name cap binds (tight stop → 20 sh cap)", sizeByRisk(10000, 100, 99) === 20);
check("sizeByRisk: stop ≥ price → 0", sizeByRisk(10000, 100, 100) === 0);

// volatility stops
check("chandelierStop: HH130 − ATR5×3 = 115", chandelierStop(130, 5) === 115);
check("atrStop: entry100 − ATR4×3 = 88", atrStop(100, 4) === 88);

// risk gate (the override): resize down to the tightest binding cap, or reject
check("riskGate: oversized buy capped to 20% per-name (50→20 sh)",
  riskGate({ symbol: "A", price: 100, stopPrice: 90, shares: 50 }, { equity: 10000, positions: [] }).shares === 20);
check("riskGate: portfolio-heat ceiling binds (10% heat, $20 room / $10 = 2 sh)",
  riskGate({ symbol: "A", price: 100, stopPrice: 90, shares: 20 }, { equity: 10000, positions: [{ symbol: "X", marketValue: 1000, riskDollars: 980 }] }).shares === 2);
check("riskGate: per-sector cap binds ($200 room / $100 = 2 sh)",
  riskGate({ symbol: "A", sector: "Tech", price: 100, stopPrice: 90, shares: 20 }, { equity: 10000, positions: [{ symbol: "AAPL", sector: "Tech", marketValue: 2800, riskDollars: 0 }] }).shares === 2);
{
  const g = riskGate({ symbol: "A", price: 100, stopPrice: 90, shares: 20 }, { equity: 10000, positions: [{ symbol: "X", marketValue: 1000, riskDollars: 1000 }] });
  check("riskGate: no room under heat → rejected (ok=false, 0 sh)", g.ok === false && g.shares === 0);
}

// bookRoom (replaces the maxOpen slot count): room = a full 1.5%-risk entry fits under the 10% heat cap
// AND buying power covers the risk budget. On $10k: budget $150, heat ceiling $1000.
{
  const low = bookRoom(10_000, 500, 5_000);   // heat 5% used, $500 room ≥ $150, BP ample
  check("bookRoom: low heat + cash → hasRoom", low.hasRoom === true && low.heatUsedPct === 5);
  const hot = bookRoom(10_000, 900, 5_000);   // $100 heat room < $150 budget → out of room
  check("bookRoom: heat near the 10% ceiling → NO room", hot.hasRoom === false);
  const broke = bookRoom(10_000, 500, 100);   // heat fine but BP $100 < $150 budget → out of room
  check("bookRoom: no buying power → NO room", broke.hasRoom === false);
  check("bookRoom: detail names the real limiter (heat + BP)", /heat 5%\/10%/.test(low.detail) && /buying power/.test(low.detail));
  check("bookRoom: zero equity → NO room, no throw", bookRoom(0, 0, 0).hasRoom === false);
}

// regime filter
check("regimeOn: price ≥ 200MA → risk-on", regimeOn(105, 100) === true);
check("regimeOn: price < 200MA → risk-off", regimeOn(95, 100) === false);
check("regimeOn: unknown MA → risk-on (don't block)", regimeOn(100, 0) === true);

// ATR from bars: TRs of [3,2] over period 2 → 2.5; too few bars → 0
{
  const bars = [{ h: 10, l: 8, c: 9 }, { h: 12, l: 9, c: 11 }, { h: 13, l: 11, c: 12 }];
  check("atrFromBars: mean of last-N true ranges (→2.5)", atrFromBars(bars, 2) === 2.5);
  check("atrFromBars: too few bars → 0", atrFromBars(bars, 22) === 0);
}

// config sanity
check("DEFAULT_RISK: moderate (1.5% risk, 10% heat, half-Kelly)", DEFAULT_RISK.riskPerTradePct === 1.5 && DEFAULT_RISK.maxPortfolioHeatPct === 10 && DEFAULT_RISK.kellyFraction === 0.5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
