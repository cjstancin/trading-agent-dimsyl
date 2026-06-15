// SUCCESS / FAIL / NULL test for the reallocation planner (no network, no orders). Run: npm run test:reallocate
import { planReallocation, holdingStrength, DEFAULT_REALLOC, type Holding, type Candidate } from "./reallocate.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

const book = { maxOpen: 4 };

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
  const plan = planReallocation(fullBook, strong, book);
  check("SUCCESS: full book + strong idea → proposes a swap", plan.needed && plan.swaps.length === 1);
  check("SUCCESS: swaps out the WEAKEST holding", plan.swaps[0]?.sell.symbol === "WEAK");
  check("SUCCESS: swaps into the candidate", plan.swaps[0]?.buy.symbol === "NVDA");
}

// FAIL (no swap): a marginal idea (40) doesn't beat WEAK (30) by the 15-pt edge → no swap, recorded as skipped.
const marginal: Candidate[] = [{ symbol: "MRGN", conviction: 40 }];
{
  const plan = planReallocation(fullBook, marginal, book);
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
  const plan = planReallocation(winnerBook, strong, book);
  check("PROTECT: a +40% winner is never swapped out", !plan.swaps.some((s) => s.sell.symbol === "RUN"));
  check("PROTECT: protected winner is noted in skipped", plan.skipped.some((s) => s.symbol === "RUN" && /let it run/.test(s.reason)));
  // NVDA (85) should instead swap the next-weakest unprotected name (MEH, 45) — 85−45=40 ≥ 15.
  check("PROTECT: swaps the next-weakest unprotected name instead", plan.swaps[0]?.sell.symbol === "MEH");
}

// Room: book below maxOpen → needed=false, buy directly, no swap proposed.
{
  const plan = planReallocation(fullBook.slice(0, 2), strong, book);
  check("ROOM: book has room → needed=false, no swaps", plan.needed === false && plan.swaps.length === 0);
}

// Already held: a candidate already in the book is skipped, not swapped into.
{
  const dupe: Candidate[] = [{ symbol: "WEAK", conviction: 90 }];
  const plan = planReallocation(fullBook, dupe, book);
  check("HELD: an already-held candidate is skipped", plan.swaps.length === 0 && plan.skipped.some((s) => s.symbol === "WEAK" && /already held/.test(s.reason)));
}

// Churn cap: many strong ideas, but at most maxSwapsPerCycle (2) swaps proposed.
{
  const many: Candidate[] = [
    { symbol: "AAA", conviction: 90 }, { symbol: "BBB", conviction: 88 },
    { symbol: "CCC", conviction: 86 }, { symbol: "DDD", conviction: 84 },
  ];
  const plan = planReallocation(fullBook, many, book);
  check("CHURN: capped at maxSwapsPerCycle swaps", plan.swaps.length === DEFAULT_REALLOC.maxSwapsPerCycle);
}

// Strength fallback: no score → derived from P&L (flat = 50, −20% → 30).
check("STRENGTH: no-score holding falls back to P&L proxy", Math.round(holdingStrength({ symbol: "X", marketValue: 1, unrealizedPlPct: -0.20 })) === 30);

// NULL: no candidates → graceful, needed=false, empty plan, no throw.
{
  const plan = planReallocation(fullBook, [], book);
  check("NULL: no candidates → empty plan, needed=false", plan.needed === false && plan.swaps.length === 0 && plan.notes.length > 0);
}
// NULL: empty book + empty candidates → graceful.
check("NULL: empty book + no candidates → no throw", planReallocation([], [], book).swaps.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
