// Unit tests for the PURE outcome-feedback prompt block (the learning loop). node:test + synthetic
// ledger-shaped closed trades only — NO network, NO orders. Covers: real stats for tags over min-N,
// the min-N neutral gate for thin tags, exclusion of open trades, fresh-account "" output, ordering,
// the time-of-day line's own min-N gate, and BULL_MIN_TAG_TRADES env parsing.
// Run: npm run test:track-record
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTrackRecordBlock, minTagTrades, tagVerdict, DEFAULT_MIN_TAG_TRADES } from "./track-record.js";
import type { AttributedTrade } from "./attribution.js";

// Synthetic closed-trade builder: n trades on a tag, `wins` of them +$50, the rest −$30.
// Timestamps land 14:00Z (June, EDT) → 10:00 ET = the "open" time-of-day bucket.
const make = (setup: string, wins: number, losses: number): AttributedTrade[] => {
  const out: AttributedTrade[] = [];
  for (let i = 0; i < wins; i++) out.push({ ts: `2026-06-${String(1 + (i % 26)).padStart(2, "0")}T14:00:00Z`, setup, outcome: "win", realizedPnlUsd: 50 });
  for (let i = 0; i < losses; i++) out.push({ ts: `2026-06-${String(1 + (i % 26)).padStart(2, "0")}T14:00:00Z`, setup, outcome: "loss", realizedPnlUsd: -30 });
  return out;
};

test("tag with n ≥ min-N surfaces its REAL stats (win-rate, expectancy, total) + a proven verdict", () => {
  // 6 wins ×$50 + 2 losses ×$30 = 8 closed → clears the default min-N of 8.
  // winRate 75%, expectancy = .75·50 + .25·(−30) = $30/trade, total +$240.
  const block = renderTrackRecordBlock(make("momentum breakout", 6, 2), 8);
  assert.match(block, /^YOUR TRACK RECORD BY SETUP/);
  assert.match(block, /momentum breakout — 8 trades, 75% win, expectancy \+\$30\/trade, total \+\$240\s+\[PROVEN EDGE — favor\]/);
});

test("negative-expectancy tag over min-N is flagged as one to avoid", () => {
  // 2 wins ×$50 + 6 losses ×$30 → winRate 25%, expectancy = .25·50 + .75·(−30) = −$10/trade.
  const block = renderTrackRecordBlock(make("chase", 2, 6), 8);
  assert.match(block, /chase — 8 trades, 25% win, expectancy −\$10\/trade, total −\$80\s+\[NEGATIVE EXPECTANCY — avoid unless exceptional\]/);
});

test("MIN-N GATE: a thin tag shows 'insufficient sample — NEUTRAL' and none of its stats", () => {
  const block = renderTrackRecordBlock(make("earnings drift", 3, 0), 8); // 3 < 8
  assert.match(block, /earnings drift — 3 closed trades \(insufficient sample, < 8 — NEUTRAL, judge on merit\)/);
  assert.ok(!/earnings drift.*100% win/.test(block), "a thin tag's win-rate must NOT be surfaced as signal");
  assert.ok(!/PROVEN/.test(block), "a thin tag must never earn a PROVEN verdict");
});

test("min-N is configurable: the same 3-trade tag is PROVEN at minN=2", () => {
  const block = renderTrackRecordBlock(make("earnings drift", 3, 0), 2);
  assert.match(block, /earnings drift — 3 trades, 100% win/);
  assert.match(block, /PROVEN EDGE/);
});

test("open / rejected-outcome trades are excluded; no closed trades → '' (fresh account adds nothing)", () => {
  assert.equal(renderTrackRecordBlock([], 8), "");
  const openOnly: AttributedTrade[] = [{ ts: "2026-06-15T14:00:00Z", setup: "breakout", outcome: "open", realizedPnlUsd: null }];
  assert.equal(renderTrackRecordBlock(openOnly, 8), "");
  // 8 closed + 5 open on the same tag → count stays 8 (open never inflates the sample)
  const mixed = [...make("breakout", 6, 2), ...Array.from({ length: 5 }, () => ({ ts: "2026-06-20T14:00:00Z", setup: "breakout", outcome: "open" as const, realizedPnlUsd: null }))];
  assert.match(renderTrackRecordBlock(mixed, 8), /breakout — 8 trades/);
});

test("ordering: proven tags (best expectancy first) before insufficient-sample tags", () => {
  const block = renderTrackRecordBlock([...make("thin", 1, 0), ...make("loserSetup", 2, 6), ...make("winnerSetup", 6, 2)], 8);
  const order = ["winnerSetup", "loserSetup", "thin"].map((t) => block.indexOf(t));
  assert.ok(order[0] < order[1] && order[1] < order[2], `expected winner < loser < thin, got ${order}`);
});

test("time-of-day line appears only when a bucket clears min-N (thin buckets → line omitted)", () => {
  const withTod = renderTrackRecordBlock(make("breakout", 6, 2), 8); // all 8 in the "open" ET bucket
  assert.match(withTod, /By time-of-day of entry \(n ≥ 8 only\): open 75% win/);
  const noTod = renderTrackRecordBlock(make("breakout", 3, 0), 8); // 3 < 8 everywhere
  assert.ok(!noTod.includes("By time-of-day"), "no ToD bucket clears min-N → the whole line is omitted");
});

test("tagVerdict applies the gate exactly at the boundary", () => {
  const bucket = { count: 8, wins: 6, winRate: 75, totalPnl: 240, avgPnl: 30, expectancy: 30 };
  assert.equal(tagVerdict(bucket, 8), "proven-positive");
  assert.equal(tagVerdict({ ...bucket, count: 7 }, 8), "insufficient");
  assert.equal(tagVerdict({ ...bucket, expectancy: -1 }, 8), "proven-negative");
  assert.equal(tagVerdict({ ...bucket, expectancy: 0 }, 8), "proven-flat");
});

test("minTagTrades: default 8; env override respected; garbage/zero → default", () => {
  assert.equal(DEFAULT_MIN_TAG_TRADES, 8);
  assert.equal(minTagTrades({}), 8);
  assert.equal(minTagTrades({ BULL_MIN_TAG_TRADES: "5" }), 5);
  assert.equal(minTagTrades({ BULL_MIN_TAG_TRADES: "12.9" }), 12);
  assert.equal(minTagTrades({ BULL_MIN_TAG_TRADES: "banana" }), 8);
  assert.equal(minTagTrades({ BULL_MIN_TAG_TRADES: "0" }), 8);
});
