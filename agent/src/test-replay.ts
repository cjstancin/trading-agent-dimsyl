// Unit tests for the backtest v2 REAL-PROPOSAL REPLAY engine (replay.ts). node:test + synthetic
// proposals against KNOWN daily price paths only — NO network, NO file I/O, NO orders. Covers every
// exit path (initial stop, gap-through, trailing stop, target, stop-beats-target, time-stop, still-open),
// the win/loss/R math, walk-forward attribution bucketing, empty-ledger handling, and that the report
// STATES its caveats. Run: npm run test:replay
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProposalRecord } from "./ledger.js";
import {
  replayProposal, replayAll, replayableProposals, parseLedgerJsonl,
  bucketVia, confidenceBucket, regimeAt, profitFactor,
  equitySeries, maxDrawdownPct, buildReport, buildReplayMd,
  type DailyBar,
} from "./replay.js";

// ── factories ──
const prop = (over: Partial<ProposalRecord> = {}): ProposalRecord => ({
  ts: "2026-06-15T14:00:00Z", cycle: "2026-06-15", symbol: "TEST", side: "buy", qty: 10, est_price: 100,
  trail_percent: 20, profile: "aggressive", mode: "auto", status: "placed", setup: "momentum breakout", confidence: 80, ...over,
});
const bar = (date: string, open: number, high: number, low: number, close: number): DailyBar => ({ date, open, high, low, close });
// consecutive June-2026 weekdays starting Mon 06-15
const D = ["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19", "2026-06-22", "2026-06-23"];

// ── exit paths ──

test("initial STOP hit: entry 100, trail 20% → stop 80; fill at the stop, R = −1, outcome loss", () => {
  const bars = [bar(D[0], 100, 100, 95, 98), bar(D[1], 90, 90, 70, 75)];
  const t = replayProposal(prop(), bars)!;
  assert.equal(t.entry, 100);
  assert.equal(t.exitReason, "stop");        // peak never ratcheted above entry
  assert.equal(t.exit, 80);                  // open 90 ≥ 80 → fill AT the stop level
  assert.equal(t.exitDate, D[1]);
  assert.equal(t.pnlUsd, -200);              // (80−100)×10
  assert.equal(t.rMultiple, -1);             // risk = 100×10×20% = $200
  assert.equal(t.retPct, -20);
  assert.equal(t.outcome, "loss");
  assert.equal(t.holdDays, 2);
});

test("GAP-THROUGH the stop: bar opens below the level → fill at the open, not the stop (R = −2)", () => {
  const bars = [bar(D[0], 100, 100, 95, 98), bar(D[1], 60, 62, 55, 58)];
  const t = replayProposal(prop(), bars)!;
  assert.equal(t.exitReason, "stop");
  assert.equal(t.exit, 60);                  // open 60 < stop 80 → open fills
  assert.equal(t.pnlUsd, -400);
  assert.equal(t.rMultiple, -2);
});

test("TRAILING stop: peak ratchets on daily highs, stop = peak×(1−trail), exit above entry = win, reason 'trail'", () => {
  // d1 flat (peak 100) · d2 runs to 150 (peak→150 for TOMORROW) · d3 falls through 150×0.8 = 120
  const bars = [bar(D[0], 100, 100, 99, 100), bar(D[1], 105, 150, 104, 148), bar(D[2], 130, 131, 110, 112)];
  const t = replayProposal(prop(), bars)!;
  assert.equal(t.exitReason, "trail");       // ratcheted above entry before exiting
  assert.equal(t.exit, 120);                 // open 130 ≥ 120 → fill at the trailed stop
  assert.equal(t.pnlUsd, 200);               // (120−100)×10
  assert.equal(t.rMultiple, 1);              // +$200 on $200 risk
  assert.equal(t.outcome, "win");
});

test("today's high cannot stop today out (stop uses the PRIOR day's peak — look-ahead-free)", () => {
  // d2 makes a new high 150 AND a low 118 (< 150×0.8 = 120) in the SAME bar → no exit on d2,
  // because d2's stop was still set from d1's peak (100 → stop 80). Exit happens d3.
  const bars = [bar(D[0], 100, 100, 99, 100), bar(D[1], 105, 150, 118, 140), bar(D[2], 119, 119, 100, 101)];
  const t = replayProposal(prop(), bars)!;
  assert.equal(t.exitDate, D[2]);
  assert.equal(t.exitReason, "trail");
  assert.equal(t.exit, 119);                 // d3 opens 119 < trailed stop 120 → gap fill at open
});

test("TARGET hit (optional hard target): fill at the target, gap-above fills at the open", () => {
  const cfg = { targetPct: 15 };             // target = 115
  const hit = replayProposal(prop(), [bar(D[0], 100, 100, 98, 100), bar(D[1], 105, 120, 104, 118)], cfg)!;
  assert.equal(hit.exitReason, "target");
  assert.equal(hit.exit, 115);
  assert.equal(hit.outcome, "win");
  assert.equal(hit.pnlUsd, 150);
  const gap = replayProposal(prop(), [bar(D[0], 100, 100, 98, 100), bar(D[1], 118, 125, 117, 124)], cfg)!;
  assert.equal(gap.exitReason, "target");
  assert.equal(gap.exit, 118);               // opened above the target
});

test("stop and target reachable in the SAME bar → the STOP wins (conservative)", () => {
  const bars = [bar(D[0], 100, 100, 98, 100), bar(D[1], 100, 130, 75, 90)];
  const t = replayProposal(prop(), bars, { targetPct: 15 })!;
  assert.equal(t.exitReason, "stop");
  assert.equal(t.exit, 80);
  assert.equal(t.outcome, "loss");
});

test("TIME-STOP: exits at the close of the Nth trading day (entry day = 1)", () => {
  const flat = D.slice(0, 5).map((d) => bar(d, 100, 101, 99.5, 101));
  const t = replayProposal(prop(), flat, { maxHoldDays: 3 })!;
  assert.equal(t.exitReason, "time");
  assert.equal(t.exitDate, D[2]);
  assert.equal(t.holdDays, 3);
  assert.equal(t.exit, 101);                 // that bar's close
  assert.equal(t.outcome, "win");            // +$10
});

test("STILL-OPEN at end of data: marked to the last close, outcome 'open', excluded from closed buckets", () => {
  const bars = [bar(D[0], 100, 101, 99, 100), bar(D[1], 102, 103, 101, 102.5)];
  const t = replayProposal(prop(), bars)!;
  assert.equal(t.exitReason, "open");
  assert.equal(t.outcome, "open");
  assert.equal(t.exit, 102.5);
  assert.equal(t.pnlUsd, 25);                // unrealized mark
  // an open trade must NOT be scored by the (live) attribution aggregation
  const buckets = bucketVia([t], (x) => x.setup ?? "untagged");
  assert.deepEqual(buckets, {});
});

test("slippage: entry pays +slip, exit pays −slip", () => {
  const bars = [bar(D[0], 100, 100, 95, 98), bar(D[1], 90, 90, 70, 75)];
  const t = replayProposal(prop(), bars, { slipBps: 100 })!;    // 1% per side
  assert.equal(t.entry, 101);                // 100 × 1.01
  assert.equal(t.exit, 79.2);                // stop 80 × 0.99
});

test("trail % falls back to the proposal's rulebook when trail_percent is missing (steady → 10%)", () => {
  // no trail_percent, profile steady → 10% trail → stop 90; low 89 fires it. (aggressive default = 20 → wouldn't.)
  const bars = [bar(D[0], 100, 100, 96, 98), bar(D[1], 95, 95, 89, 91)];
  const t = replayProposal(prop({ trail_percent: undefined, profile: "steady" }), bars)!;
  assert.equal(t.trailPct, 10);
  assert.equal(t.exitReason, "stop");
  assert.equal(t.exit, 90);
});

test("entry sanity-clamp: est_price far outside the entry bar → fill at the bar's open, flagged", () => {
  const bars = [bar(D[0], 100, 102, 98, 101), bar(D[1], 100, 101, 99, 100)];
  const t = replayProposal(prop({ est_price: 500 }), bars)!;    // 500 ≫ high×1.2
  assert.equal(t.entry, 100);
  assert.equal(t.entryClamped, true);
});

test("no bar on/after the proposal date → null (skipped, not invented)", () => {
  const past = [bar("2026-06-01", 100, 101, 99, 100)];
  assert.equal(replayProposal(prop(), past), null);
  assert.equal(replayProposal(prop(), []), null);
});

// ── eligibility + ledger parsing ──

test("replayableProposals: only buy proposals with status proposed/placed and positive qty/price", () => {
  const ledger = [
    prop(),                                                       // in
    prop({ status: "proposed" }),                                 // in
    prop({ side: "sell" }),                                       // out: exits aren't entries
    prop({ status: "rejected" }),                                 // out: never traded
    prop({ qty: 0 }),                                             // out
    prop({ est_price: 0 }),                                       // out
  ];
  assert.equal(replayableProposals(ledger).length, 2);
});

test("parseLedgerJsonl: tolerant of corrupt lines and blank input (empty ledger → [])", () => {
  const text = JSON.stringify(prop()) + "\n{not json}\n\n" + JSON.stringify(prop({ symbol: "B" })) + "\n";
  assert.equal(parseLedgerJsonl(text).length, 2);
  assert.deepEqual(parseLedgerJsonl(""), []);
});

test("replayAll: symbols without price data land in `skipped`, the rest replay", () => {
  const ledger = [prop({ symbol: "HAS" }), prop({ symbol: "MISSING" })];
  const bars = { HAS: [bar(D[0], 100, 100, 95, 98), bar(D[1], 90, 90, 70, 75)] };
  const { trades, skipped } = replayAll(ledger, bars, {});
  assert.equal(trades.length, 1);
  assert.equal(trades[0].symbol, "HAS");
  assert.deepEqual(skipped, ["MISSING @ 2026-06-15"]);
});

// ── walk-forward attribution ──

test("bucketVia aggregates with the SAME math as live attribution (per-tag win%, P&L, expectancy)", () => {
  const bars = {
    W: [bar(D[0], 100, 100, 99, 100), bar(D[1], 105, 150, 104, 148), bar(D[2], 130, 131, 110, 112)], // trail win +200
    L: [bar(D[0], 100, 100, 95, 98), bar(D[1], 90, 90, 70, 75)],                                      // stop loss −200
    L2: [bar(D[0], 100, 100, 95, 98), bar(D[1], 90, 90, 70, 75)],                                     // stop loss −200
  };
  const ledger = [
    prop({ symbol: "W", setup: "breakout" }),
    prop({ symbol: "L", setup: "breakout" }),
    prop({ symbol: "L2", setup: "pullback" }),
  ];
  const { trades } = replayAll(ledger, bars, {});
  const bySetup = bucketVia(trades, (t) => t.setup ?? "untagged");
  assert.deepEqual(Object.keys(bySetup).sort(), ["breakout", "pullback"]);
  assert.deepEqual(bySetup.breakout, { count: 2, wins: 1, winRate: 50, totalPnl: 0, avgPnl: 0, expectancy: 0 }); // +200 −200
  assert.deepEqual(bySetup.pullback, { count: 1, wins: 0, winRate: 0, totalPnl: -200, avgPnl: -200, expectancy: -200 });
});

test("confidenceBucket edges: <50 / 50-69 / 70-84 / 85+ / unrated", () => {
  assert.equal(confidenceBucket(49), "<50");
  assert.equal(confidenceBucket(50), "50-69");
  assert.equal(confidenceBucket(69), "50-69");
  assert.equal(confidenceBucket(70), "70-84");
  assert.equal(confidenceBucket(84), "70-84");
  assert.equal(confidenceBucket(85), "85+");
  assert.equal(confidenceBucket(null), "unrated");
  assert.equal(confidenceBucket(undefined), "unrated");
});

test("regimeAt is walk-forward: uses only closes ≤ the date; short history → neutral (fail-open)", () => {
  const rising: DailyBar[] = Array.from({ length: 260 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    return bar(d, 100 + i, 100 + i, 100 + i, 100 + i);
  });
  const lastDate = rising[rising.length - 1].date;
  assert.equal(regimeAt(rising, lastDate), "risk-on");             // above a rising 200-DMA
  assert.equal(regimeAt(rising, rising[50].date), "neutral");      // only 51 closes visible → fail-open
  const falling = rising.map((b, i) => ({ ...b, close: 500 - i }));
  assert.equal(regimeAt(falling, lastDate), "risk-off");           // below a falling 200-DMA
  assert.equal(regimeAt([], "2026-06-15"), "neutral");
});

// ── aggregates ──

test("profitFactor: gross wins ÷ gross losses; ∞ with no losses; 0 when empty; ignores open trades", () => {
  const bars = {
    W: [bar(D[0], 100, 100, 99, 100), bar(D[1], 105, 150, 104, 148), bar(D[2], 130, 131, 110, 112)], // +200
    L: [bar(D[0], 100, 100, 95, 98), bar(D[1], 90, 90, 75, 76)],                                      // −200 (stop 80)
    O: [bar(D[0], 100, 101, 99, 100)],                                                                // open
  };
  const { trades } = replayAll([prop({ symbol: "W" }), prop({ symbol: "L" }), prop({ symbol: "O" })], bars, {});
  assert.equal(profitFactor(trades), 1);                            // 200 / 200
  assert.equal(profitFactor(trades.filter((t) => t.symbol === "W")), Infinity);
  assert.equal(profitFactor([]), 0);
});

test("equitySeries marks open positions daily and books P&L on the exit date; maxDrawdownPct is peak-to-trough", () => {
  const bars = { X: [bar(D[0], 100, 100, 95, 95), bar(D[1], 90, 90, 70, 75), bar(D[2], 75, 76, 74, 75)] };
  const { trades } = replayAll([prop({ symbol: "X" })], bars, {});  // stop-out d2 at 80 → −$200
  const eq = equitySeries(trades, bars, [D[0], D[1], D[2]], 1000);
  assert.deepEqual(eq, [
    { date: D[0], equity: 950 },   // marked at d1 close 95 → −$50 unrealized
    { date: D[1], equity: 800 },   // realized −$200
    { date: D[2], equity: 800 },
  ]);
  assert.equal(maxDrawdownPct(eq), -15.79);                         // 800 vs the 950 peak
  assert.equal(maxDrawdownPct([]), 0);
});

// ── report + honest labelling ──

const SPY_BARS = [bar(D[0], 500, 501, 499, 500), bar(D[1], 501, 502, 500, 505), bar(D[2], 505, 506, 504, 510)];

test("buildReport: totals, exit mix, vs-SPY and the four walk-forward bucket views from real replays", () => {
  const bars = {
    W: [bar(D[0], 100, 100, 99, 100), bar(D[1], 105, 150, 104, 148), bar(D[2], 130, 131, 110, 112)], // +200 trail win
    L: [bar(D[0], 100, 100, 95, 98), bar(D[1], 90, 90, 75, 76), bar(D[2], 76, 77, 75, 76)],           // −200 stop loss
  };
  const ledger = [prop({ symbol: "W", setup: "breakout", confidence: 90 }), prop({ symbol: "L", setup: "pullback", confidence: 55 })];
  const { trades, skipped } = replayAll(ledger, bars, {});
  const r = buildReport({ proposals: 2, trades, skipped, barsBySym: bars, spyBars: SPY_BARS, cfg: {}, initCap: 1000, now: "2026-07-06T00:00:00Z" });
  assert.equal(r.counts.replayed, 2);
  assert.equal(r.counts.closed, 2);
  assert.equal(r.totals.pnlUsd, 0);
  assert.equal(r.totals.winRate, 50);
  assert.equal(r.totals.profitFactor, 1);
  assert.deepEqual(r.exitReasons, { trail: 1, stop: 1 });
  assert.deepEqual(Object.keys(r.bySetup).sort(), ["breakout", "pullback"]);
  assert.deepEqual(Object.keys(r.byConfidence).sort(), ["50-69", "85+"]);
  assert.equal(r.byRegime.neutral.count, 2);                        // 3 SPY closes ≪ 220 → walk-forward fail-open
  assert.equal(r.byTimeOfDay.open.count, 2);                        // 14:00Z = 10:00 ET
  assert.equal(r.totals.spyRetPct, 2);                              // SPY 500 → 510 over the window
  assert.equal(r.window!.first, D[0]);
  assert.equal(r.window!.last, D[2]);
});

test("REPORT STATES ITS CAVEATS: not-a-forward-guarantee, survivorship, look-ahead, LLM exits, mirage", () => {
  const bars = { L: [bar(D[0], 100, 100, 95, 98), bar(D[1], 90, 90, 75, 76)] };
  const { trades, skipped } = replayAll([prop({ symbol: "L" })], bars, {});
  const md = buildReplayMd(buildReport({ proposals: 1, trades, skipped, barsBySym: bars, spyBars: SPY_BARS, cfg: { slipBps: 5 }, initCap: 1000 }));
  assert.match(md, /NOT a forward guarantee/i);
  assert.match(md, /survivorship/i);
  assert.match(md, /look-ahead/i);
  assert.match(md, /LLM-driven exits are NOT replayed/i);
  assert.match(md, /mirage/i);
  assert.match(md, /not investment advice/i);
  // and the honest separation from the plumbing backtest is spelled out
  assert.match(md, /mechanical/i);
  assert.match(md, /real.*proposals|actual logged proposals/i);
});

test("EMPTY LEDGER: zero proposals → report + markdown render cleanly with no trades and the caveats intact", () => {
  const r = buildReport({ proposals: 0, trades: [], skipped: [], barsBySym: {}, spyBars: [], cfg: {}, initCap: 1000 });
  assert.equal(r.counts.replayed, 0);
  assert.equal(r.window, null);
  assert.equal(r.totals.winRate, 0);
  assert.equal(r.totals.profitFactor, 0);
  assert.deepEqual(r.bySetup, {});
  const md = buildReplayMd(r);
  assert.match(md, /No replayable proposals/);
  assert.match(md, /NOT a forward guarantee/i);
});
