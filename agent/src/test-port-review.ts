// Unit tests for the PURE PORT aggregation (John von Neumann's combined-book risk review). node:test +
// small synthetic books only — NO network, NO orders, NO broker. Covers net long/short, single-name +
// sector concentration, cross-trader crowding, combined drawdown vs budget, proposal derivation, and the
// graceful-degradation paths (no books / single book / missing book). Run: npm run test:port-review
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateExposure, singleNameConcentration, sectorConcentration, crossTraderOverlap,
  combinedDrawdown, buildProposals, portReview, DEFAULT_PORT_CONFIG, APPROVE_TAG, type Book,
} from "./port-review.js";

// Bill: long AAPL 40k + MSFT 20k + JPM 10k = 70k gross, peak 100k, equity 95k (−5k DD).
// Hakari: long AAPL 10k (crowds AAPL) + short TSLA 5k = 15k gross, peak 20k, equity 18k.
const BILL: Book = {
  trader: "Bill", present: true, equityUsd: 95_000, peakEquityUsd: 100_000,
  positions: [
    { symbol: "AAPL", qty: 100, marketValueUsd: 40_000 },
    { symbol: "MSFT", qty: 50, marketValueUsd: 20_000 },
    { symbol: "JPM", qty: 80, marketValueUsd: 10_000 },
  ],
};
const HAKARI: Book = {
  trader: "Hakari", present: true, equityUsd: 18_000, peakEquityUsd: 20_000,
  positions: [
    { symbol: "AAPL", qty: 25, marketValueUsd: 10_000 },
    { symbol: "TSLA", qty: -20, marketValueUsd: -5_000 },   // short
  ],
};
const ABSENT: Book = { trader: "Hakari", present: false, positions: [] };

test("aggregateExposure sums signed net long/short across present books", () => {
  const e = aggregateExposure([BILL, HAKARI]);
  // long = 40+20+10+10 = 80k ; short = 5k ; gross = 85k ; net = 75k
  assert.equal(e.longUsd, 80_000);
  assert.equal(e.shortUsd, 5_000);
  assert.equal(e.grossUsd, 85_000);
  assert.equal(e.netUsd, 75_000);
  assert.equal(e.equityUsd, 113_000);                       // 95k + 18k
  assert.equal(e.positions, 5);
  assert.equal(e.netPctEquity, Math.round((75_000 / 113_000) * 10000) / 100);
});

test("aggregateExposure ignores absent books and survives an empty floor", () => {
  assert.equal(aggregateExposure([BILL, ABSENT]).positions, 3);
  const flat = aggregateExposure([]);
  assert.deepEqual([flat.grossUsd, flat.netUsd, flat.positions, flat.netPctEquity], [0, 0, 0, 0]);
});

test("singleNameConcentration combines a name across books and sorts by combined value", () => {
  const n = singleNameConcentration([BILL, HAKARI]);
  assert.equal(n[0].symbol, "AAPL");                        // 40k + 10k = 50k, the largest
  assert.equal(n[0].marketValueUsd, 50_000);
  assert.deepEqual(n[0].traders, ["Bill", "Hakari"]);       // held by both desks
  assert.equal(n[0].pctOfGross, Math.round((50_000 / 85_000) * 10000) / 100);
  // TSLA short contributes its absolute value to gross/concentration.
  assert.equal(n.find((x) => x.symbol === "TSLA")?.marketValueUsd, 5_000);
});

test("sectorConcentration maps via the sector map and buckets unmapped names under Unknown", () => {
  const s = sectorConcentration([BILL, HAKARI]);
  const tech = s.find((x) => x.sector === "Technology");   // AAPL 50k + MSFT 20k = 70k
  assert.equal(tech?.marketValueUsd, 70_000);
  assert.equal(s.find((x) => x.sector === "Financials")?.marketValueUsd, 10_000);   // JPM
  assert.equal(s.find((x) => x.sector === "Consumer")?.marketValueUsd, 5_000);      // TSLA
  // A position's own sector field wins over the map; an unmapped symbol → Unknown.
  const custom = sectorConcentration([{ trader: "X", present: true, positions: [
    { symbol: "AAPL", qty: 1, marketValueUsd: 100, sector: "Custom" },
    { symbol: "ZZZZ", qty: 1, marketValueUsd: 50 },
  ] }]);
  assert.equal(custom.find((x) => x.sector === "Custom")?.marketValueUsd, 100);
  assert.equal(custom.find((x) => x.sector === "Unknown")?.marketValueUsd, 50);
});

test("crossTraderOverlap surfaces only names held by >1 desk", () => {
  const c = crossTraderOverlap([BILL, HAKARI]);
  assert.equal(c.length, 1);
  assert.equal(c[0].symbol, "AAPL");
  assert.deepEqual(c[0].traders, ["Bill", "Hakari"]);
  assert.equal(c[0].combinedUsd, 50_000);
  // A single book can have no crowding.
  assert.deepEqual(crossTraderOverlap([BILL]), []);
});

test("combinedDrawdown measures dd from combined peak vs the notional budget", () => {
  const d = combinedDrawdown([BILL, HAKARI]);              // peak 120k, equity 113k → dd 7k
  assert.equal(d.combinedPeakUsd, 120_000);
  assert.equal(d.combinedEquityUsd, 113_000);
  assert.equal(d.drawdownUsd, 7_000);
  assert.equal(d.budgetUsd, 18_000);                       // 15% of 120k
  assert.equal(d.overBudget, false);                       // 7k < 18k
  // Peak is floored to current — a book reporting a peak below its mark cannot fake a drawdown.
  const noPeak = combinedDrawdown([{ trader: "B", present: true, equityUsd: 100, peakEquityUsd: 50, positions: [] }]);
  assert.equal(noPeak.drawdownUsd, 0);
});

test("combinedDrawdown flags overBudget when drawdown exceeds the budget", () => {
  const deep = combinedDrawdown([{ trader: "B", present: true, equityUsd: 70, peakEquityUsd: 100, positions: [] }]);
  // dd 30, budget 15 → over budget, budgetUsedPct 200
  assert.equal(deep.drawdownUsd, 30);
  assert.equal(deep.budgetUsd, 15);
  assert.equal(deep.overBudget, true);
  assert.equal(deep.budgetUsedPct, 200);
});

test("buildProposals: over-cap single name + crowding, every proposal tagged, capped at maxProposals", () => {
  const r = portReview([BILL, HAKARI]);                    // AAPL 58.8% > 25% cap, Tech 82% > 40% cap
  assert.ok(r.proposals.length >= 1 && r.proposals.length <= DEFAULT_PORT_CONFIG.maxProposals);
  assert.ok(r.proposals.every((p) => p.tag === APPROVE_TAG));
  assert.ok(r.proposals.some((p) => p.kind === "single-name" && p.title.includes("AAPL")));
  // AAPL is over the single-name cap, so it must NOT also appear as a separate crowding proposal.
  assert.equal(r.proposals.filter((p) => p.title.includes("AAPL")).length, 1);
});

test("buildProposals ranks drawdown-over-budget first", () => {
  const deep: Book = { trader: "Bill", present: true, equityUsd: 50_000, peakEquityUsd: 100_000,
    positions: [{ symbol: "AAPL", qty: 1, marketValueUsd: 40_000 }, { symbol: "MSFT", qty: 1, marketValueUsd: 10_000 }] };
  const r = portReview([deep]);
  assert.equal(r.drawdown.overBudget, true);
  assert.equal(r.proposals[0].kind, "drawdown");
});

test("a balanced book yields zero proposals", () => {
  const balanced: Book = { trader: "Bill", present: true, equityUsd: 100_000, peakEquityUsd: 100_000,
    positions: [
      { symbol: "AAPL", qty: 1, marketValueUsd: 10_000 }, { symbol: "JPM", qty: 1, marketValueUsd: 10_000 },
      { symbol: "XOM", qty: 1, marketValueUsd: 10_000 }, { symbol: "UNH", qty: 1, marketValueUsd: 10_000 },
      { symbol: "CAT", qty: 1, marketValueUsd: 10_000 },
    ] };
  const r = portReview([balanced]);
  assert.deepEqual(r.proposals, []);
});

test("portReview degrades: no books, single book, and missing book are all noted (never fabricated)", () => {
  const none = portReview([ABSENT]);
  assert.deepEqual(none.booksReviewed, []);
  assert.deepEqual(none.booksMissing, ["Hakari"]);
  assert.ok(none.notes.some((n) => /No books found/.test(n)));
  assert.deepEqual(none.proposals, []);

  const solo = portReview([BILL, ABSENT]);
  assert.deepEqual(solo.booksReviewed, ["Bill"]);
  assert.deepEqual(solo.booksMissing, ["Hakari"]);
  assert.ok(solo.notes.some((n) => /Single-book review/.test(n)));
  assert.ok(solo.notes.some((n) => /not present/.test(n)));
  assert.deepEqual(solo.crowding, []);                     // no crowding assessable with one desk
});
