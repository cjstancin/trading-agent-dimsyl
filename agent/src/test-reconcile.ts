// Unit tests for reconcile()'s pure back-fill helpers (finding: side-filter + wrong default trail).
// node:test + synthetic ledger records only — NO network, NO file I/O, NO orders. Run: npm run test:reconcile
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchProposal, trailForProposal } from "./reconcile.js";
import type { ProposalRecord } from "./ledger.js";

// Minimal ledger-record factory — only the fields the back-fill matcher reads.
const rec = (over: Partial<ProposalRecord>): ProposalRecord => ({
  ts: "2026-06-15T14:00:00Z", cycle: "2026-06-15", symbol: "AMD", side: "buy", qty: 10, est_price: 100,
  profile: "aggressive", mode: "auto", status: "placed", outcome: "open", ...over,
});

test("matchProposal: only matches BUY proposals — a SELL proposal for the same symbol is never the entry", () => {
  // The latest open proposal for AMD is a SELL (e.g. a trim/exit). The closed long round-trip must NOT
  // bind to it; it must bind to the earlier open BUY. Without the side filter the sell (last in cand)
  // would be mismarked win/loss.
  const ledger = [
    rec({ ts: "2026-06-15T14:00:00Z", side: "buy" }),
    rec({ ts: "2026-06-16T14:00:00Z", side: "sell" }),
  ];
  const prop = matchProposal(ledger, "AMD", "2026-06-17T00:00:00Z");
  assert.ok(prop, "should find a proposal");
  assert.equal(prop!.side, "buy");
  assert.equal(prop!.ts, "2026-06-15T14:00:00Z");
});

test("matchProposal: picks the LATEST open buy at/before the close; ignores future + non-open + other symbols", () => {
  const ledger = [
    rec({ ts: "2026-06-14T14:00:00Z", side: "buy" }),                       // older buy
    rec({ ts: "2026-06-15T14:00:00Z", side: "buy" }),                       // latest qualifying buy
    rec({ ts: "2026-06-15T14:00:00Z", side: "buy", outcome: "win" }),       // already closed — excluded
    rec({ ts: "2026-06-15T14:00:00Z", side: "buy", symbol: "TSLA" }),       // other symbol — excluded
    rec({ ts: "2026-06-20T14:00:00Z", side: "buy" }),                       // after the close — excluded
  ];
  const prop = matchProposal(ledger, "AMD", "2026-06-16T00:00:00Z");
  assert.ok(prop);
  assert.equal(prop!.ts, "2026-06-15T14:00:00Z");
  assert.equal(prop!.outcome, "open");
});

test("matchProposal: returns null when no open buy proposal precedes the close", () => {
  const ledger = [rec({ side: "sell" }), rec({ symbol: "TSLA" })];
  assert.equal(matchProposal(ledger, "AMD", "2026-06-16T00:00:00Z"), null);
});

test("trailForProposal: uses the proposal's own trail_percent when set", () => {
  assert.equal(trailForProposal(rec({ trail_percent: 12 })), 12);
});

test("trailForProposal: falls back to the rulebook trail for the profile — never the invented 18", () => {
  // Aggressive rulebook trail is 20, steady is 10. The old code invented 18, which no rulebook uses.
  assert.equal(trailForProposal(rec({ profile: "aggressive", trail_percent: null })), 20);
  assert.equal(trailForProposal(rec({ profile: "steady", trail_percent: null })), 10);
  // No proposal at all → aggressive default (rulesFor defaults to aggressive).
  assert.equal(trailForProposal(null), 20);
  assert.notEqual(trailForProposal(rec({ trail_percent: null })), 18);
});
