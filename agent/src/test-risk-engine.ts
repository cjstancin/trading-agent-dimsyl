// Tests for the deterministic risk engine (no network). Run: npm run test:risk-engine
import { inverseVolWeights, volTargetLeverage, fractionalKelly, sizeByRisk, chandelierStop, atrStop, riskGate, regimeOn, DEFAULT_RISK } from "./risk-engine.js";

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
check("sizeByRisk: risk-budget binds (10000,$100,stop$90 → 10 sh)", sizeByRisk(10000, 100, 90) === 10);
check("sizeByRisk: per-name cap binds (tight stop → 20 sh cap)", sizeByRisk(10000, 100, 99) === 20);
check("sizeByRisk: stop ≥ price → 0", sizeByRisk(10000, 100, 100) === 0);

// volatility stops
check("chandelierStop: HH130 − ATR5×3 = 115", chandelierStop(130, 5) === 115);
check("atrStop: entry100 − ATR4×3 = 88", atrStop(100, 4) === 88);

// risk gate (the override): resize down to the tightest binding cap, or reject
check("riskGate: oversized buy capped to 20% per-name (50→20 sh)",
  riskGate({ symbol: "A", price: 100, stopPrice: 90, shares: 50 }, { equity: 10000, positions: [] }).shares === 20);
check("riskGate: portfolio-heat ceiling binds (room $20 / $10 risk = 2 sh)",
  riskGate({ symbol: "A", price: 100, stopPrice: 90, shares: 20 }, { equity: 10000, positions: [{ symbol: "X", marketValue: 1000, riskDollars: 580 }] }).shares === 2);
check("riskGate: per-sector cap binds ($200 room / $100 = 2 sh)",
  riskGate({ symbol: "A", sector: "Tech", price: 100, stopPrice: 90, shares: 20 }, { equity: 10000, positions: [{ symbol: "AAPL", sector: "Tech", marketValue: 2800, riskDollars: 0 }] }).shares === 2);
{
  const g = riskGate({ symbol: "A", price: 100, stopPrice: 90, shares: 20 }, { equity: 10000, positions: [{ symbol: "X", marketValue: 1000, riskDollars: 600 }] });
  check("riskGate: no room under heat → rejected (ok=false, 0 sh)", g.ok === false && g.shares === 0);
}

// regime filter
check("regimeOn: price ≥ 200MA → risk-on", regimeOn(105, 100) === true);
check("regimeOn: price < 200MA → risk-off", regimeOn(95, 100) === false);
check("regimeOn: unknown MA → risk-on (don't block)", regimeOn(100, 0) === true);

// config sanity
check("DEFAULT_RISK: 1% risk, 6% heat, half-Kelly", DEFAULT_RISK.riskPerTradePct === 1 && DEFAULT_RISK.maxPortfolioHeatPct === 6 && DEFAULT_RISK.kellyFraction === 0.5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
