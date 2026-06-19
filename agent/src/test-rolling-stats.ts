// Unit tests for the PURE rolling (recent-form) analytics. node:test + a small synthetic closed-trade set
// only — NO network, NO orders. Covers recency windowing (most-recent-N by ts, regardless of input order),
// the exact stats.ts-mirrored math, window-larger-than-total, exclusion of non-win/loss outcomes, the empty
// case, and the Discord footer renderer. Run: npm run test:rolling-stats
import { test } from "node:test";
import assert from "node:assert/strict";
import { rollingStats, renderRollingFooter } from "./rolling-stats.js";

// Five closed trades on consecutive days, plus one still-open (must be excluded). Deliberately OUT of ts
// order to prove rollingStats sorts by entry ts before taking the tail.
const TRADES = [
  { ts: "2026-06-12T14:00:00Z", outcome: "win", realizedPnlUsd: 80 },
  { ts: "2026-06-10T14:00:00Z", outcome: "win", realizedPnlUsd: 100 },
  { ts: "2026-06-14T14:00:00Z", outcome: "win", realizedPnlUsd: 60 },
  { ts: "2026-06-11T14:00:00Z", outcome: "loss", realizedPnlUsd: -50 },
  { ts: "2026-06-15T14:00:00Z", outcome: "open", realizedPnlUsd: null }, // still open — EXCLUDED
  { ts: "2026-06-13T14:00:00Z", outcome: "loss", realizedPnlUsd: -40 },
];

test("rolling window takes the most-recent-N closed trades by entry ts (input order irrelevant)", () => {
  const { last3 } = rollingStats(TRADES, [3]);
  // most-recent 3 by ts: 06-12 win +80, 06-13 loss -40, 06-14 win +60 (06-11/06-10 fall out, open excluded)
  assert.equal(last3.window, 3);
  assert.equal(last3.trades, 3);
  assert.equal(last3.wins, 2);
  assert.equal(last3.losses, 1);
  assert.equal(last3.winRate, 67);                 // round(2/3*100)
  assert.equal(last3.avgWin, 70);                  // mean(80, 60)
  assert.equal(last3.avgLoss, -40);                // lone loss, negative sign mirrors stats.ts
  // expectancy = (67/100)*70 + (1-0.67)*(-40) = 46.9 - 13.2 = 33.7
  assert.equal(last3.expectancy, 33.7);
});

test("window >= total closed reproduces the all-time numbers over every closed trade", () => {
  const { last10 } = rollingStats(TRADES, [10]);
  // all 5 closed: wins +100,+80,+60 (avg 80) · losses -50,-40 (avgLoss -45) · winRate round(3/5)=60
  assert.equal(last10.trades, 5);
  assert.equal(last10.wins, 3);
  assert.equal(last10.losses, 2);
  assert.equal(last10.winRate, 60);
  assert.equal(last10.avgWin, 80);
  assert.equal(last10.avgLoss, -45);
  // expectancy = 0.6*80 + 0.4*(-45) = 48 - 18 = 30
  assert.equal(last10.expectancy, 30);
});

test("default windows are last10 + last20", () => {
  const r = rollingStats(TRADES);
  assert.deepEqual(Object.keys(r).sort(), ["last10", "last20"]);
  assert.equal(r.last10.trades, 5);
  assert.equal(r.last20.trades, 5);
});

test("empty / no-closed input → zeroed windows (no crash)", () => {
  const r = rollingStats([]);
  assert.deepEqual(r.last10, { window: 10, trades: 0, wins: 0, losses: 0, winRate: 0, avgWin: 0, avgLoss: 0, expectancy: 0 });
  const onlyOpen = rollingStats([{ ts: "2026-06-15T14:00:00Z", outcome: "open", realizedPnlUsd: null }], [5]);
  assert.equal(onlyOpen.last5.trades, 0);
  assert.equal(onlyOpen.last5.expectancy, 0);
});

test("renderRollingFooter: empty when no closed trades, formatted line otherwise", () => {
  assert.equal(renderRollingFooter(rollingStats([])), "");
  const footer = renderRollingFooter(rollingStats(TRADES, [3]));
  assert.match(footer, /^📊 Recent form \(rolling\): /);
  assert.match(footer, /last 3 — 67% win/);
  assert.match(footer, /avg \$70 \/ −\$40/);       // avg win $70 / avg loss −$40
  assert.match(footer, /exp \+\$33\.7/);
  assert.match(footer, /\(3 trades\)/);
});
