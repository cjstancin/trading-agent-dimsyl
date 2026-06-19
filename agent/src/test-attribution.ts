// Unit tests for the PURE attribution analytics (Bull backlog #9). node:test + a small synthetic closed-
// trade set only — NO network, NO orders. Covers setup / time-of-day (ET) / day-of-week bucketing plus a
// couple of aggregates, and the exclusion of non-win/loss outcomes. Run: npm run test:attribution
import { test } from "node:test";
import assert from "node:assert/strict";
import { attribution, renderAttributionFooter } from "./attribution.js";

// Synthetic closed trades. Timestamps are UTC; the ET conversions (June → EDT, UTC-4) are:
//   13:00Z→09:00 ET (premarket) · 14:00Z→10:00 (open) · 13:30Z→09:30 (open) · 18:00Z→14:00 (midday) · 20:30Z→16:30 (close)
//   2026-06-15 Mon · 06-16 Tue · 06-17 Wed · 06-18 Thu
const TRADES = [
  { ts: "2026-06-15T14:00:00Z", setup: "breakout", outcome: "win", realizedPnlUsd: 100 },   // Mon, open
  { ts: "2026-06-16T13:30:00Z", setup: "breakout", outcome: "loss", realizedPnlUsd: -40 },   // Tue, open
  { ts: "2026-06-15T13:00:00Z", setup: "pullback", outcome: "win", realizedPnlUsd: 60 },     // Mon, premarket
  { ts: "2026-06-18T18:00:00Z", setup: "pullback", outcome: "loss", realizedPnlUsd: -20 },    // Thu, midday
  { ts: "2026-06-17T20:30:00Z", setup: null, outcome: "win", realizedPnlUsd: 30 },            // Wed, close, untagged
  { ts: "2026-06-19T14:30:00Z", setup: "breakout", outcome: "open", realizedPnlUsd: null },   // still open — EXCLUDED
];

test("bySetup groups by tag; untagged setups bucket under 'untagged'; open trades excluded", () => {
  const { bySetup } = attribution(TRADES);
  assert.deepEqual(Object.keys(bySetup).sort(), ["breakout", "pullback", "untagged"]);
  // breakout: +100 win, -40 loss
  assert.deepEqual(bySetup.breakout, { count: 2, wins: 1, winRate: 50, totalPnl: 60, avgPnl: 30, expectancy: 30 });
  // untagged: the null-setup win
  assert.equal(bySetup.untagged.count, 1);
  assert.equal(bySetup.untagged.winRate, 100);
  assert.equal(bySetup.untagged.totalPnl, 30);
});

test("byTimeOfDay buckets entries into ET sessions", () => {
  const { byTimeOfDay } = attribution(TRADES);
  assert.deepEqual(Object.keys(byTimeOfDay).sort(), ["close", "midday", "open", "premarket"]);
  assert.equal(byTimeOfDay.open.count, 2);        // 10:00 + 09:30 ET
  assert.equal(byTimeOfDay.open.winRate, 50);
  assert.equal(byTimeOfDay.premarket.count, 1);   // 09:00 ET
  assert.equal(byTimeOfDay.midday.count, 1);      // 14:00 ET
  assert.equal(byTimeOfDay.close.count, 1);       // 16:30 ET
});

test("byDayOfWeek aggregates P&L and win-rate per weekday (ET)", () => {
  const { byDayOfWeek } = attribution(TRADES);
  assert.deepEqual(Object.keys(byDayOfWeek).sort(), ["Mon", "Thu", "Tue", "Wed"]);
  // Mon: two wins (+100, +60)
  assert.deepEqual(byDayOfWeek.Mon, { count: 2, wins: 2, winRate: 100, totalPnl: 160, avgPnl: 80, expectancy: 80 });
  assert.equal(byDayOfWeek.Tue.winRate, 0);       // lone loss
  assert.equal(byDayOfWeek.Tue.totalPnl, -40);
});

test("empty / no-closed input → empty buckets (no crash)", () => {
  assert.deepEqual(attribution([]), { bySetup: {}, byTimeOfDay: {}, byDayOfWeek: {} });
  const onlyOpen = attribution([{ ts: "2026-06-15T14:00:00Z", setup: "x", outcome: "open", realizedPnlUsd: null }]);
  assert.deepEqual(onlyOpen, { bySetup: {}, byTimeOfDay: {}, byDayOfWeek: {} });
});

test("expectancy follows the textbook formula (winRate·avgWin + lossRate·avgLoss)", () => {
  // 3 trades: +90 win, +30 win, -60 loss → winRate 2/3, avgWin 60, avgLoss -60
  // expectancy = (2/3)·60 + (1/3)·(-60) = 40 - 20 = 20
  const { bySetup } = attribution([
    { ts: "2026-06-15T14:00:00Z", setup: "s", outcome: "win", realizedPnlUsd: 90 },
    { ts: "2026-06-15T15:00:00Z", setup: "s", outcome: "win", realizedPnlUsd: 30 },
    { ts: "2026-06-15T16:00:00Z", setup: "s", outcome: "loss", realizedPnlUsd: -60 },
  ]);
  assert.equal(bySetup.s.expectancy, 20);
  assert.equal(bySetup.s.totalPnl, 60);
  assert.equal(bySetup.s.avgPnl, 20);
});

test("unparseable timestamp → 'unknown' time/day bucket (still counted by setup)", () => {
  const a = attribution([{ ts: "not-a-date", setup: "z", outcome: "win", realizedPnlUsd: 10 }]);
  assert.equal(a.bySetup.z.count, 1);
  assert.equal(a.byTimeOfDay.unknown.count, 1);
  assert.equal(a.byDayOfWeek.unknown.count, 1);
});

test("renderAttributionFooter sorts setups by P&L desc and renders P&L · win-rate · count", () => {
  // breakout +60 (50% win, 2) · pullback +40 (1 win) · loser −20 (0% win, 1)
  const footer = renderAttributionFooter(attribution([
    { ts: "2026-06-15T14:00:00Z", setup: "breakout", outcome: "win", realizedPnlUsd: 100 },
    { ts: "2026-06-16T14:00:00Z", setup: "breakout", outcome: "loss", realizedPnlUsd: -40 },
    { ts: "2026-06-15T14:00:00Z", setup: "pullback", outcome: "win", realizedPnlUsd: 40 },
    { ts: "2026-06-15T14:00:00Z", setup: "loser", outcome: "loss", realizedPnlUsd: -20 },
  ]));
  assert.equal(footer, "🧭 By strategy (P&L): breakout +$60 · 50% win (2) | pullback +$40 · 100% win (1) | loser −$20 · 0% win (1)");
});

test("renderAttributionFooter: no tagged closed trades → '' (fresh account adds nothing)", () => {
  assert.equal(renderAttributionFooter(attribution([])), "");
  // an open trade is excluded by attribution(), so still nothing to render
  assert.equal(renderAttributionFooter(attribution([{ ts: "2026-06-15T14:00:00Z", setup: "x", outcome: "open", realizedPnlUsd: null }])), "");
});

test("renderAttributionFooter ties broken by name, and caps the tail with '+N more'", () => {
  // four setups all at +$0 totalPnl → name-ascending order; limit 2 shows the first two + "+2 more"
  const trades = ["d", "c", "b", "a"].map((s) => ({ ts: "2026-06-15T14:00:00Z", setup: s, outcome: "win" as const, realizedPnlUsd: 0 }));
  const footer = renderAttributionFooter(attribution(trades), 2);
  assert.equal(footer, "🧭 By strategy (P&L): a +$0 · 100% win (1) | b +$0 · 100% win (1) | +2 more");
});
