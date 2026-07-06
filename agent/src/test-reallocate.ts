// SUCCESS / FAIL / NULL test for the reallocation planner (no network, no orders). Run: npm run test:reallocate
import { planReallocation, holdingStrength, DEFAULT_REALLOC, type Holding, type Candidate } from "./reallocate.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

// No fixed slot count anymore: "full" = no room to ADD under the risk/heat/cash constraints (bookRoom).
const full = { hasRoom: false, roomDetail: "heat 9.8%/10% used" };  // out of room → swaps are the only way in
const roomy = { hasRoom: true, roomDetail: "heat 3%/10% used" };    // room → buy directly, no swap

// A full book of four laggards (scores 30–55) — the weakest is WEAK at 30.
const fullBook: Holding[] = [
  { symbol: "WEAK", marketValue: 8000, unrealizedPlPct: -0.05, score: 30 },
  { symbol: "MEH",  marketValue: 9000, unrealizedPlPct: 0.01,  score: 45 },
  { symbol: "OK",   marketValue: 10000, unrealizedPlPct: 0.03, score: 52 },
  { symbol: "FINE", marketValue: 11000, unrealizedPlPct: 0.04, score: 55 },
];

// SUCCESS: full book + a high-conviction fresh idea (85) → swap out the weakest (WEAK, 30).
const strong: Candidate[] = [{ symbol: "NVDA", conviction: 85, thesis: "AI capex breakout", setup: "momentum breakout" }];
{
  const plan = planReallocation(fullBook, strong, full);
  check("SUCCESS: full book + strong idea → proposes a swap", plan.needed && plan.swaps.length === 1);
  check("SUCCESS: swaps out the WEAKEST holding", plan.swaps[0]?.sell.symbol === "WEAK");
  check("SUCCESS: swaps into the candidate", plan.swaps[0]?.buy.symbol === "NVDA");
}

// FAIL (no swap): WEAK is score 30, down −5% → strength 20 (30 − 5%·2). A marginal idea (30) doesn't beat
// it by the 15-pt edge (30 − 20 = 10 < 15) → no swap, recorded as skipped.
const marginal: Candidate[] = [{ symbol: "MRGN", conviction: 30 }];
{
  const plan = planReallocation(fullBook, marginal, full);
  check("FAIL: marginal idea → no swap", plan.needed && plan.swaps.length === 0);
  check("FAIL: marginal idea recorded as skipped", plan.skipped.some((s) => s.symbol === "MRGN"));
}

// Protect winners: make the weakest-by-score holding a big winner (+40%) → it must NOT be swapped out.
const winnerBook: Holding[] = [
  { symbol: "RUN", marketValue: 14000, unrealizedPlPct: 0.40, score: 30 }, // low score BUT up 40% → protected
  { symbol: "MEH",  marketValue: 9000, unrealizedPlPct: 0.01,  score: 45 },
  { symbol: "OK",   marketValue: 10000, unrealizedPlPct: 0.03, score: 52 },
  { symbol: "FINE", marketValue: 11000, unrealizedPlPct: 0.04, score: 55 },
];
{
  const plan = planReallocation(winnerBook, strong, full);
  check("PROTECT: a +40% winner is never swapped out", !plan.swaps.some((s) => s.sell.symbol === "RUN"));
  check("PROTECT: protected winner is noted in skipped", plan.skipped.some((s) => s.symbol === "RUN" && /let it run/.test(s.reason)));
  // NVDA (85) should instead swap the next-weakest unprotected name (MEH, 45) — 85−45=40 ≥ 15.
  check("PROTECT: swaps the next-weakest unprotected name instead", plan.swaps[0]?.sell.symbol === "MEH");
}

// Room: heat/cash room to simply add → needed=false, buy directly, no swap proposed (any position count).
{
  const plan = planReallocation(fullBook, strong, roomy);
  check("ROOM: book has risk-cap room → needed=false, no swaps", plan.needed === false && plan.swaps.length === 0);
}

// Already held: a candidate already in the book is skipped, not swapped into.
{
  const dupe: Candidate[] = [{ symbol: "WEAK", conviction: 90 }];
  const plan = planReallocation(fullBook, dupe, full);
  check("HELD: an already-held candidate is skipped", plan.swaps.length === 0 && plan.skipped.some((s) => s.symbol === "WEAK" && /already held/.test(s.reason)));
}

// Churn cap: many strong ideas, but at most maxSwapsPerCycle (2) swaps proposed.
{
  const many: Candidate[] = [
    { symbol: "AAA", conviction: 90 }, { symbol: "BBB", conviction: 88 },
    { symbol: "CCC", conviction: 86 }, { symbol: "DDD", conviction: 84 },
  ];
  const plan = planReallocation(fullBook, many, full);
  check("CHURN: capped at maxSwapsPerCycle swaps", plan.swaps.length === DEFAULT_REALLOC.maxSwapsPerCycle);
}

// Strength fallback: no score → derived from P&L (flat = 50, −20% → 30).
check("STRENGTH: no-score holding falls back to P&L proxy", Math.round(holdingStrength({ symbol: "X", marketValue: 1, unrealizedPlPct: -0.20 })) === 30);
// Strength tilt (CJ "worst in book"): a high-conviction holding decays as it bleeds; a modest gain firms it.
check("STRENGTH: live loss decays a high-conviction holding (78, −12% → 54)", Math.round(holdingStrength({ symbol: "B", marketValue: 1, unrealizedPlPct: -0.12, score: 78 })) === 54);
check("STRENGTH: a modest gain firms strength (60, +4% → 64)", holdingStrength({ symbol: "G", marketValue: 1, unrealizedPlPct: 0.04, score: 60 }) === 64);

// LOSS-TILT planner: a bleeding high-conviction name becomes the swap target even though its raw conviction
// would have protected it. BLEED (78, −12% → strength 54) vs three flat 70s; FRESH (72) clears 72−54=18 ≥ 15.
{
  const bleeder: Holding[] = [
    { symbol: "BLEED", marketValue: 9000, unrealizedPlPct: -0.12, score: 78 },
    { symbol: "FLAT1", marketValue: 9000, unrealizedPlPct: 0.0, score: 70 },
    { symbol: "FLAT2", marketValue: 9000, unrealizedPlPct: 0.0, score: 70 },
    { symbol: "FLAT3", marketValue: 9000, unrealizedPlPct: 0.0, score: 70 },
  ];
  const plan = planReallocation(bleeder, [{ symbol: "FRESH", conviction: 72 }], full);
  check("LOSS-TILT: a bleeding high-conviction name becomes the swap target", plan.swaps[0]?.sell.symbol === "BLEED");
}

// NULL: no candidates → graceful, needed=false, empty plan, no throw.
{
  const plan = planReallocation(fullBook, [], full);
  check("NULL: no candidates → empty plan, needed=false", plan.needed === false && plan.swaps.length === 0 && plan.notes.length > 0);
}
// NULL: empty book + empty candidates → graceful.
check("NULL: empty book + no candidates → no throw", planReallocation([], [], full).swaps.length === 0);
// NULL: empty book + no room (e.g. no cash) → nothing to swap OUT of, so needed=false and no swaps.
check("NULL: empty book with no room → needed=false (nothing to swap)", planReallocation([], strong, full).needed === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
