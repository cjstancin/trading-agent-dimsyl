// Unit tests for the PURE per-symbol trade memory (learning loop, part 2). node:test + synthetic
// ledger-shaped closed trades only — NO network, NO orders. Covers: correct W/L / avg-R / total / last
// for a symbol with history, null/"" for untraded symbols, open-trade exclusion, the scan block's symbol
// listing + small-sample framing + recency cap, the avg-$ fallback when no R data exists, word-bounded
// approved-cycle symbol matching, and the proposed-names annotation block.
// Run: npm run test:symbol-record
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  symbolRecords, symbolRecord, renderSymbolRecordLine, renderSymbolHistoryBlock,
  renderProposedSymbolHistory, tradedSymbolsIn, DEFAULT_SYMBOL_HISTORY_CAP, type SymbolTrade,
} from "./symbol-record.js";

// Synthetic closed-trade builder: ledger-shaped rows (structural subset of ProposalRecord).
const t = (symbol: string, over: Partial<SymbolTrade> = {}): SymbolTrade => ({
  ts: "2026-06-10T14:00:00Z", symbol, setup: "momentum breakout", outcome: "loss", realizedPnlUsd: -50, rMultiple: -1, ...over,
});

// MU: 1W/2L — win +$50 (+0.6R), loss −$112 (−2.1R), last loss −$80 (−1.2R) on failed-breakout.
// → 3 trades, total −$142, avg R = (0.6 − 2.1 − 1.2)/3 = −0.9R, last: 2026-06-20 failed-breakout loss −1.2R.
const MU: SymbolTrade[] = [
  t("MU", { ts: "2026-06-01T14:00:00Z", outcome: "win", realizedPnlUsd: 50, rMultiple: 0.6 }),
  t("MU", { ts: "2026-06-10T14:00:00Z", outcome: "loss", realizedPnlUsd: -112, rMultiple: -2.1 }),
  t("MU", { ts: "2026-06-20T14:00:00Z", outcome: "loss", realizedPnlUsd: -80, rMultiple: -1.2, setup: "failed-breakout" }),
];

test("per-symbol record: correct count / W-L / avg R / total / last (setup + outcome + R) for a name with history", () => {
  const rec = symbolRecord(MU, "MU");
  assert.ok(rec, "MU has closed history → record must exist");
  assert.equal(rec.count, 3);
  assert.equal(rec.wins, 1);
  assert.equal(rec.losses, 2);
  assert.equal(rec.avgR, -0.9);
  assert.equal(rec.totalPnl, -142);
  assert.equal(rec.lastDate, "2026-06-20");
  assert.equal(rec.lastSetup, "failed-breakout");
  assert.equal(rec.lastOutcome, "loss");
  assert.equal(rec.lastR, -1.2);
  assert.deepEqual(rec.setups, ["momentum breakout", "failed-breakout"]);
  const line = renderSymbolRecordLine(rec);
  assert.match(line, /MU: 3 trades · 1W\/2L · avg −0\.9R · total −\$142 · last: 2026-06-20 failed-breakout loss −1\.2R/);
});

test("symbol lookup is case-insensitive and returns null for an untraded name", () => {
  assert.ok(symbolRecord(MU, "mu"), "lower-case lookup must still hit");
  assert.equal(symbolRecord(MU, "TSLA"), null);
  assert.equal(symbolRecord([], "MU"), null);
  assert.equal(symbolRecord(MU, ""), null);
});

test("open / non-closed outcomes are EXCLUDED — they never inflate a record, and open-only history renders nothing", () => {
  const mixed = [...MU,
    t("MU", { ts: "2026-07-01T14:00:00Z", outcome: "open", realizedPnlUsd: null, rMultiple: null }),
    t("MU", { ts: "2026-07-02T14:00:00Z", outcome: "expired", realizedPnlUsd: null, rMultiple: null }),
  ];
  const rec = symbolRecord(mixed, "MU");
  assert.ok(rec);
  assert.equal(rec.count, 3, "open/expired rows must not count as closed trades");
  assert.equal(rec.lastDate, "2026-06-20", "an open row must not become the 'last' closed trade");
  const openOnly = [t("NVDA", { outcome: "open", realizedPnlUsd: null, rMultiple: null })];
  assert.equal(symbolRecord(openOnly, "NVDA"), null);
  assert.equal(renderSymbolHistoryBlock(openOnly), "");
  assert.equal(renderSymbolHistoryBlock([]), "", "fresh account adds nothing to the prompt");
});

test("scan block lists every traded symbol (most recently traded first) with the small-sample HISTORY framing", () => {
  const trades = [...MU, t("NVDA", { ts: "2026-06-25T14:00:00Z", outcome: "win", realizedPnlUsd: 120, rMultiple: 1.4 })];
  const block = renderSymbolHistoryBlock(trades);
  assert.match(block, /^SYMBOLS YOU'VE TRADED BEFORE/);
  assert.match(block, /• NVDA: 1 trade · 1W\/0L/);
  assert.match(block, /• MU: 3 trades · 1W\/2L/);
  assert.ok(block.indexOf("NVDA") < block.indexOf("MU: 3"), "most recently traded name must list first");
  // Framing: history-not-edge, small sample, never a hard block on a re-buy.
  assert.match(block, /HISTORY, not a statistical edge/);
  assert.match(block, /samples are small/);
  assert.match(block, /past loss never forbids a re-buy/);
  assert.ok(!/PROVEN|avoid unless exceptional/.test(block), "per-symbol history must never carry setup-style verdicts");
});

test("scan block is CAPPED at the most recently traded names and DISCLOSES the tail", () => {
  assert.equal(DEFAULT_SYMBOL_HISTORY_CAP, 20);
  const many: SymbolTrade[] = Array.from({ length: 5 }, (_, i) =>
    t(`SYM${i}`, { ts: `2026-06-${String(10 + i).padStart(2, "0")}T14:00:00Z`, outcome: "win", realizedPnlUsd: 10, rMultiple: 0.2 }));
  const block = renderSymbolHistoryBlock(many, 3);
  assert.match(block, /• SYM4:/); // newest three kept
  assert.match(block, /• SYM3:/);
  assert.match(block, /• SYM2:/);
  assert.ok(!block.includes("• SYM1:") && !block.includes("• SYM0:"), "older names beyond the cap are dropped from the list");
  assert.match(block, /\(\+2 more previously traded names not shown — 3 most recently traded kept\)/);
});

test("no R-multiple data → avg falls back to $/trade instead of inventing an R", () => {
  const noR = [
    t("AMD", { ts: "2026-06-01T14:00:00Z", outcome: "loss", realizedPnlUsd: -60, rMultiple: null }),
    t("AMD", { ts: "2026-06-05T14:00:00Z", outcome: "loss", realizedPnlUsd: -40, rMultiple: undefined }),
  ];
  const rec = symbolRecord(noR, "AMD");
  assert.ok(rec);
  assert.equal(rec.avgR, null);
  assert.match(renderSymbolRecordLine(rec), /avg −\$50\/trade · total −\$100/);
});

test("tradedSymbolsIn: word-bounded matches against the traded set only — no substring or prose false hits", () => {
  const trades = [...MU, t("A", { outcome: "win", realizedPnlUsd: 5, rMultiple: 0.1 })];
  assert.deepEqual(tradedSymbolsIn(trades, "• MU — pullback-in-uptrend, entry 120"), ["MU"]);
  assert.deepEqual(tradedSymbolsIn(trades, "MUSK-adjacent momentum names"), [], "MU inside MUSK must not match");
  assert.deepEqual(tradedSymbolsIn(trades, "A single ticker: MU"), ["A", "MU"]);
  assert.deepEqual(tradedSymbolsIn(trades, ""), []);
  assert.deepEqual(tradedSymbolsIn([], "MU NVDA"), []);
});

test("proposed-names annotation: records only for symbols WITH history, '' when none (fail open), dedup + case-insensitive", () => {
  const block = renderProposedSymbolHistory(MU, ["mu", "MU", "TSLA"]);
  assert.match(block, /^YOUR HISTORY ON THESE NAMES/);
  assert.match(block, /HISTORY, not a statistical edge/);
  assert.equal(block.match(/• MU:/g)?.length, 1, "duplicate symbols must render once");
  assert.ok(!block.includes("TSLA"), "a name with no history adds nothing");
  assert.equal(renderProposedSymbolHistory(MU, ["TSLA", "NVDA"]), "");
  assert.equal(renderProposedSymbolHistory(MU, []), "");
});
