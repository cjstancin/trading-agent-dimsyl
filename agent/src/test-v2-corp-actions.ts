// Offline tests — v2 corporate actions: planCorporateActions (held filter, exit-before routing,
// forward-split ratios, dividends, unknown bucket), applyDueActions (split applied + broker-stale
// flag, dividend credited idempotently at ex-date, future-dated untouched), and the ritual glue
// (bigint-safe plan serialization, morning exit routing). :memory: db + mock broker; no network.
import { openDb, getState } from "./v2/db.js";
import { d9, d9str } from "./v2/decimal.js";
import { loadConfig, DEFAULTS_PATH } from "./v2/config.js";
import { seedBook } from "./v2/settled-cash.js";
import { ingestFill, ledgerPosition } from "./v2/lots.js";
import type { BrokerPort, BrokerOrderRequest, SubmitResult } from "./v2/broker.js";
import {
  planCorporateActions, applyDueActions, type CorporateAnnouncement, type CorporateActionsPlan,
} from "./v2/book/corporate-actions.js";
import {
  serializeCorpPlan, deserializeCorpPlan, storeCorpPlan, readCorpPlan, morningCorpActions,
} from "./v2/rituals/corp-actions.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

function mockBroker(): BrokerPort & { submits: BrokerOrderRequest[] } {
  const submits: BrokerOrderRequest[] = [];
  return {
    submits,
    async submit(req): Promise<SubmitResult> { submits.push(req); return { outcome: "accepted", order: { id: `oid-${submits.length}`, status: "accepted" } }; },
    async queryByClientOrderId() { return null; },
    async getOpenOrders() { return []; },
    async cancelOrder() { return true; },
  };
}

const EFF = loadConfig(DEFAULTS_PATH, DEFAULTS_PATH + ".no-journal");
const TODAY = "2026-08-17";

console.log("v2 corp actions — planCorporateActions:");
{
  const anns: CorporateAnnouncement[] = [
    { symbol: "AAPL", type: "forward_split", exDate: "2026-08-20", newRate: 4, oldRate: 1 },
    { symbol: "ZZZZ", type: "cash_dividend", exDate: "2026-08-19", cashRate: 0.5 },              // not held → dropped
    { symbol: "RVSP", type: "reverse_split", effectiveDate: "2026-08-25", newRate: 1, oldRate: 10 },
    { symbol: "MRGR", type: "cash_merger", effectiveDate: "2026-09-01" },
    { symbol: "AAPL", type: "cash_dividend", exDate: "2026-08-18", cashRate: 0.26 },
    { symbol: "AAPL", type: "unknown", raw: { weird: true } },
    { symbol: "RVSP", type: "reverse_split" },                                                    // no effective date → unknown
    { symbol: "AAPL", type: "forward_split", exDate: "2026-08-21", newRate: 0, oldRate: 1 },      // bad ratio → unknown
    { symbol: "AAPL", type: "cash_dividend", exDate: "2026-08-22", cashRate: 0 },                 // zero rate → dropped
  ];
  const held = new Set(["AAPL", "RVSP", "MRGR"]);
  const plan = planCorporateActions(anns, held);

  check("held filter drops un-held dividend", plan.dividends.every((d) => d.symbol !== "ZZZZ"));
  check("reverse split → exitBefore", plan.exitBefore.some((e) => e.symbol === "RVSP" && e.type === "reverse_split" && e.effectiveDate === "2026-08-25"));
  check("cash merger → exitBefore", plan.exitBefore.some((e) => e.symbol === "MRGR" && e.type === "cash_merger"));
  const fs = plan.forwardSplits.find((s) => s.symbol === "AAPL");
  check("forward split ratio parsed 4:1", !!fs && fs.num === 4n && fs.den === 1n && fs.exDate === "2026-08-20");
  const dv = plan.dividends.find((d) => d.symbol === "AAPL");
  check("dividend captured at ex-date", !!dv && dv.exDate === "2026-08-18" && d9str(dv.perShare9) === "0.26");
  check("zero-rate dividend dropped", plan.dividends.length === 1);
  check("unknown bucket: unknown type + dateless reverse + bad ratio", plan.unknown.length === 3, `got ${plan.unknown.length}`);
}

console.log("v2 corp actions — applyDueActions:");
{
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-01");
  ingestFill(db, { id: "cf1", symbol: "AAPL", side: "buy", qty9: d9("10"), price9: d9("100"), ts: "2026-08-10T14:31:00Z", sleeve: "mom" });

  const plan: CorporateActionsPlan = {
    exitBefore: [],
    forwardSplits: [{ symbol: "AAPL", num: 2n, den: 1n, exDate: TODAY }],
    dividends: [{ symbol: "AAPL", exDate: TODAY, perShare9: d9("0.5") }],
    unknown: [],
  };
  const r1 = applyDueActions(db, plan, TODAY);
  check("split applied to the ledger", r1.splitsApplied === 1 && d9str(ledgerPosition(db, "AAPL")) === "20");
  check("broker-stale flag set", getState(db, "split_stale:AAPL") !== null);
  const divRows = db.prepare("SELECT amount9, settles_on FROM cash_events WHERE kind='dividend'").all() as { amount9: string; settles_on: string }[];
  check("dividend credited at ex-date (pre-split qty × rate)", divRows.length === 1 && divRows[0].amount9 === "5" && divRows[0].settles_on === TODAY);

  // Idempotency: a second pass with the same dividend credits nothing (ref-unique).
  const r2 = applyDueActions(db, { ...plan, forwardSplits: [] }, TODAY);
  check("dividend idempotent by ref", r2.dividendsCredited === 0
    && (db.prepare("SELECT COUNT(*) AS n FROM cash_events WHERE kind='dividend'").get() as { n: number }).n === 1);

  // Future-dated actions untouched.
  const future: CorporateActionsPlan = {
    exitBefore: [],
    forwardSplits: [{ symbol: "AAPL", num: 3n, den: 1n, exDate: "2026-08-20" }],
    dividends: [{ symbol: "AAPL", exDate: "2026-08-21", perShare9: d9("1") }],
    unknown: [],
  };
  const r3 = applyDueActions(db, future, TODAY);
  check("future-dated split/dividend untouched", r3.splitsApplied === 0 && r3.dividendsCredited === 0 && d9str(ledgerPosition(db, "AAPL")) === "20");
}

console.log("v2 corp actions — ritual glue (serialize + morning exits):");
{
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-01");
  ingestFill(db, { id: "cg1", symbol: "MRGR", side: "buy", qty9: d9("5"), price9: d9("20"), ts: "2026-08-10T14:31:00Z", sleeve: "ins" });

  const plan: CorporateActionsPlan = {
    exitBefore: [{ symbol: "MRGR", type: "cash_merger", effectiveDate: "2026-08-25" }],
    forwardSplits: [{ symbol: "MRGR", num: 7n, den: 2n, exDate: "2026-09-01" }],
    dividends: [{ symbol: "MRGR", exDate: "2026-08-30", perShare9: d9("0.125") }],
    unknown: [{ symbol: "MRGR", type: "unknown" }],
  };
  const round = deserializeCorpPlan(serializeCorpPlan(plan));
  check("serialize/deserialize round-trips bigints", round.forwardSplits[0].num === 7n && round.forwardSplits[0].den === 2n
    && d9str(round.dividends[0].perShare9) === "0.125" && round.exitBefore[0].symbol === "MRGR" && round.unknown.length === 1);

  storeCorpPlan(db, plan);
  check("stored plan reads back", readCorpPlan(db)?.exitBefore.length === 1);

  const broker = mockBroker();
  const posts: string[] = [];
  const res = await morningCorpActions(db, broker, EFF, {
    today: TODAY, tradesAllowed: true,
    latestPrice: async (s) => (s === "MRGR" ? 21 : null),
    post: async (t) => { posts.push(t); },
  });
  check("exit-before routed as owning-sleeve sell", res.exitsPlaced.length === 1 && res.exitsPlaced[0].sleeve === "ins"
    && broker.submits.some((s) => s.symbol === "MRGR" && s.side === "sell" && s.qty === "5"));
  check("watchlist exit row recorded", (db.prepare("SELECT COUNT(*) AS n FROM wl_exits WHERE symbol='MRGR'").get() as { n: number }).n === 1);
  check("executed exit removed from the stored plan", readCorpPlan(db)?.exitBefore.length === 0);
  check("exit posted a trade note", posts.some((p) => p.includes("MRGR") && p.toLowerCase().includes("sell")));

  // Gated mode: computed, posted, NOT placed, plan kept.
  const db2 = openDb(":memory:");
  seedBook(db2, "5000", "2026-08-01");
  ingestFill(db2, { id: "cg2", symbol: "MRGR", side: "buy", qty9: d9("5"), price9: d9("20"), ts: "2026-08-10T14:31:00Z", sleeve: "ins" });
  storeCorpPlan(db2, plan);
  const broker2 = mockBroker();
  const posts2: string[] = [];
  const res2 = await morningCorpActions(db2, broker2, EFF, {
    today: TODAY, tradesAllowed: false, latestPrice: async () => 21, post: async (t) => { posts2.push(t); },
  });
  check("gated: exit computed but not placed", res2.exitsWouldPlace.length === 1 && broker2.submits.length === 0
    && readCorpPlan(db2)?.exitBefore.length === 1 && posts2.some((p) => p.includes("would SELL")));

  // Missed effective date → escalation, no order.
  const db3 = openDb(":memory:");
  seedBook(db3, "5000", "2026-08-01");
  ingestFill(db3, { id: "cg3", symbol: "MRGR", side: "buy", qty9: d9("5"), price9: d9("20"), ts: "2026-08-10T14:31:00Z", sleeve: "ins" });
  storeCorpPlan(db3, { ...plan, exitBefore: [{ symbol: "MRGR", type: "cash_merger", effectiveDate: "2026-08-15" }] });
  const broker3 = mockBroker();
  const posts3: string[] = [];
  const res3 = await morningCorpActions(db3, broker3, EFF, {
    today: TODAY, tradesAllowed: true, latestPrice: async () => 21, post: async (t) => { posts3.push(t); },
  });
  check("passed effective date → escalated, not traded", res3.missedExits.length === 1 && broker3.submits.length === 0
    && posts3.some((p) => p.includes("PASSED")));
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall corp-actions tests passed");
process.exit(failures ? 1 : 0);
