// Offline regressions for the Sep3 APH split and late dividend entitlement incident.
// Every DB is in-memory; broker writes are observable mocks, never network calls.
import assert from "node:assert/strict";
import { openDb, getState, setState } from "./v2/db.js";
import { d9, d9str } from "./v2/decimal.js";
import { ingestFill, ledgerPosition } from "./v2/lots.js";
import { seedBook, recordCash, settledCash } from "./v2/settled-cash.js";
import { loadConfig, DEFAULTS_PATH } from "./v2/config.js";
import { alpacaCorporateActions, applyDueActions, type CorporateActionsPlan } from "./v2/book/corporate-actions.js";
import { preflightCorporateActions, morningCorpActions, nightlyCorpPoll, storeCorpPlan, readCorpPlan } from "./v2/rituals/corp-actions.js";
import type { BrokerPort, BrokerOrderRequest } from "./v2/broker.js";

const TODAY = "2026-09-03";
const empty = (): CorporateActionsPlan => ({ exitBefore: [], forwardSplits: [], dividends: [], unknown: [] });
const splitPlan = (): CorporateActionsPlan => ({
  ...empty(), forwardSplits: [{ symbol: "APH", exDate: TODAY, num: 2n, den: 1n }],
});
function holding(symbol = "APH", qty = "1.260077353") {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-01");
  ingestFill(db, {
    id: "buy", symbol, side: "buy", sleeve: "mom", qty9: d9(qty), price9: d9("159.268"),
    ts: "2026-09-02T14:35:03.419727Z",
  });
  return db;
}
function cards(db: ReturnType<typeof openDb>) {
  return db.prepare("SELECT kind,title,payload,status FROM approvals").all();
}
function inventory(db: ReturnType<typeof openDb>) {
  return JSON.stringify({ lots: db.prepare("SELECT * FROM lots").all(), fills: db.prepare("SELECT * FROM fills").all() });
}

{
  const db = holding();
  const before = inventory(db);
  const cash = settledCash(db, TODAY);
  const res = applyDueActions(db, splitPlan(), TODAY);
  assert.equal(res.splitsApplied, 0);
  assert.equal(res.splitsDeferred, 1);
  assert.equal(res.halted, true);
  assert.equal(inventory(db), before, "direct apply must never multiply the executable lot or forge fills");
  assert.equal(d9str(ledgerPosition(db, "APH")), "1.260077353");
  assert.equal(settledCash(db, TODAY), cash);
  assert.equal(getState(db, "corp:applied:APH:2026-09-03"), null);
  assert.equal(getState(db, "split_stale:APH"), null);
  const evidence = JSON.parse(getState(db, "corp:pending:split:APH:2026-09-03")!);
  assert.equal(evidence.num, "2");
  assert.equal(evidence.den, "1");
  assert.equal(evidence.exDate, TODAY);
  assert.equal(evidence.ledgerQty9, "1.260077353");
  assert.equal(evidence.lots[0].qty_remaining9, "1.260077353");
  assert.match(evidence.reason, /unverified/);
  assert.equal(cards(db).length, 1);
  console.log("✓ direct split containment preserves inventory/cash and records actionable evidence");
}

{
  const db = holding();
  storeCorpPlan(db, splitPlan());
  preflightCorporateActions(db, TODAY);
  const reason = getState(db, "halt:book");
  const evidence = getState(db, "corp:pending:split:APH:2026-09-03");
  preflightCorporateActions(db, TODAY);
  storeCorpPlan(db, empty());
  const later = preflightCorporateActions(db, "2026-09-04");
  assert.equal(later.splitsDeferred, 1, "replacing a nightly plan cannot erase the unresolved split");
  assert.equal(getState(db, "halt:book"), reason);
  assert.equal(getState(db, "corp:pending:split:APH:2026-09-03"), evidence, "first-observed evidence is immutable");
  assert.equal(cards(db).length, 1);
  // Acknowledging an operator card is not a repair of the accounting issue.
  db.prepare("UPDATE approvals SET status='approved'").run();
  preflightCorporateActions(db, TODAY);
  assert.equal(cards(db).length, 1);
  assert.equal(getState(db, "halt:book"), reason);
  console.log("✓ repeated/empty-plan preflight preserves one card and the original halt/evidence");
}

{
  const db = holding("APH", "2.520154706");
  const before = inventory(db);
  const marker = JSON.stringify({ num: "2", den: "1", ts: TODAY + "T00:00:00Z" });
  setState(db, "split_stale:APH", marker);
  setState(db, "corp:applied:APH:2026-09-03", TODAY);
  const res = preflightCorporateActions(db, "2026-09-04");
  assert.equal(res.splitsDeferred, 1, "legacy stale split is discovered without any current plan");
  assert.equal(res.halted, true);
  assert.equal(inventory(db), before, "containment does not undo the genuine split automatically");
  assert.equal(getState(db, "split_stale:APH"), marker);
  assert.equal(getState(db, "corp:applied:APH:2026-09-03"), TODAY);
  assert.equal(JSON.parse(getState(db, "corp:pending:split:APH:2026-09-03")!).staleMarker, marker);
  console.log("✓ legacy APH mutation is contained without automatic reversal or marker clearing");
}

{
  const db = holding();
  setState(db, "halt:book", "operator freeze: preserve this exact reason");
  storeCorpPlan(db, splitPlan());
  preflightCorporateActions(db, TODAY);
  assert.equal(getState(db, "halt:book"), "operator freeze: preserve this exact reason");
  assert.equal(cards(db).length, 1);
  console.log("✓ an existing operator/reconciliation halt is never overwritten");
}

{
  const db = holding();
  const future = splitPlan();
  future.forwardSplits[0].exDate = "2026-09-10";
  future.dividends.push({ symbol: "APH", exDate: "2026-09-10", perShare9: d9("1") });
  storeCorpPlan(db, future);
  const res = preflightCorporateActions(db, TODAY);
  assert.equal(res.halted, false);
  assert.equal(res.splitsDeferred + res.dividendsDeferred, 0);
  assert.equal(cards(db).length, 0);
  const flat = openDb(":memory:");
  storeCorpPlan(flat, splitPlan());
  setState(flat, "split_stale:APH", JSON.stringify({ num: "2", den: "1", ts: TODAY + "T00:00:00Z" }));
  assert.equal(preflightCorporateActions(flat, TODAY).halted, false, "a never-held/flat symbol alone does not create a fresh split halt");
  assert.equal(cards(flat).length, 0);
  console.log("✓ future actions and stale markers for flat symbols do not create fresh halts");
}

{
  const db = holding("AMAT", "0.454605173");
  const plan = { ...empty(), dividends: [{ symbol: "AMAT", exDate: "2026-08-20", perShare9: d9("0.53") }] };
  const cashBefore = JSON.stringify(db.prepare("SELECT * FROM cash_events").all());
  storeCorpPlan(db, plan);
  const first = preflightCorporateActions(db, TODAY);
  const second = preflightCorporateActions(db, TODAY);
  assert.equal(first.dividendsCredited, 0);
  assert.equal(first.dividendsDeferred, 1);
  assert.equal(second.dividendsDeferred, 1);
  assert.equal(first.halted, false, "ordinary entitlement deferral alone does not permanently freeze the book");
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM cash_events").all()), cashBefore);
  const evidence = JSON.parse(getState(db, "corp:pending:div:AMAT:2026-08-20")!);
  assert.equal(evidence.entitlementQty9, null, "unknown historical entitlement must not become current qty or zero");
  assert.equal(evidence.currentQty9, "0.454605173");
  assert.equal(cards(db).length, 1);
  console.log("✓ Sep2 AMAT purchase cannot receive an unverified Aug20 dividend or additional cash");
}

{
  const db = holding("AMAT");
  const plan = { ...empty(), dividends: [{ symbol: "AMAT", exDate: "2026-08-20", perShare9: d9("0.53") }] };
  recordCash(db, { ts: "2026-08-20T00:00:00Z", kind: "dividend", symbol: "AMAT", amount9: d9("0.240940742"), settlesOn: "2026-08-20", ref: "div:AMAT:2026-08-20", note: "legacy credit" });
  const before = JSON.stringify(db.prepare("SELECT * FROM cash_events").all());
  const res = applyDueActions(db, plan, TODAY);
  assert.equal(res.dividendsCredited, 0);
  assert.equal(res.dividendsDeferred, 0);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM cash_events").all()), before);
  assert.equal(cards(db).length, 0);
  console.log("✓ existing credits remain unchanged; this patch neither duplicates nor repairs them");
}

{
  const db = holding();
  const plan = splitPlan();
  plan.exitBefore.push({ symbol: "APH", type: "cash_merger", effectiveDate: "2026-09-10" });
  plan.dividends.push({ symbol: "APH", exDate: TODAY, perShare9: d9("1") });
  storeCorpPlan(db, plan);
  const submits: BrokerOrderRequest[] = [];
  const broker: BrokerPort = {
    async submit(req) { submits.push(req); return { outcome: "accepted", order: { id: "mock" } }; },
    async queryByClientOrderId() { return null; }, async getOpenOrders() { return []; }, async cancelOrder() { return true; },
  };
  const posts: string[] = [];
  const res = await morningCorpActions(db, broker, loadConfig(DEFAULTS_PATH, DEFAULTS_PATH + ".no-journal"), {
    today: TODAY, tradesAllowed: true, latestPrice: async () => 80, post: async text => { posts.push(text); },
  });
  assert.equal(submits.length, 0);
  assert.equal(res.exitsPlaced.length, 0);
  assert.equal(readCorpPlan(db)!.exitBefore.length, 1, "blocked exits remain pending");
  assert.equal(getState(db, "corp:applied:APH:2026-09-03"), null);
  assert(posts.some(p => p.includes("unresolved")));
  assert(posts.some(p => p.includes("dividend") && p.includes("deferred")));
  assert(posts.every(p => !p.includes("self-credited") && !p.includes("applied to the ledger")));
  console.log("✓ direct morning entry cannot submit exits, burn split markers, or falsely claim credits");
}

{
  const db = holding();
  const before = inventory(db);
  db.exec("CREATE TRIGGER reject_corp_card BEFORE INSERT ON approvals BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  assert.throws(() => applyDueActions(db, splitPlan(), TODAY), /fixture failure/);
  assert.equal(getState(db, "corp:pending:split:APH:2026-09-03"), null);
  assert.equal(getState(db, "halt:book"), null);
  assert.equal(inventory(db), before);
  db.exec("DROP TRIGGER reject_corp_card");
  assert.equal(applyDueActions(db, splitPlan(), TODAY).halted, true);
  assert.equal(cards(db).length, 1);
  console.log("✓ an evidence/card write failure is atomic and retryable");
}

{
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.ALPACA_API_KEY;
  const savedSecret = process.env.ALPACA_API_SECRET;
  const sensitiveFixture = "DO_NOT_INCLUDE_FIXTURE_BODY_OR_ERROR";
  let fetchCalls = 0;
  const query = () => alpacaCorporateActions.announcements(["APH"], TODAY, "2026-09-17");
  function reply(body: unknown, status = 200, raw = false) {
    globalThis.fetch = async (input, init) => {
      fetchCalls++;
      const url = new URL(String(input));
      assert.equal(url.origin, "https://data.alpaca.markets");
      assert.equal(url.pathname, "/v1/corporate-actions");
      assert.equal(url.searchParams.get("symbols"), "APH");
      assert.equal(init?.method ?? "GET", "GET");
      assert(init?.signal);
      return new Response(raw ? String(body) : JSON.stringify(body), { status });
    };
  }
  async function rejectsSanitized(expectedGroup?: string) {
    await assert.rejects(query, (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /^Alpaca corporate-actions snapshot /);
      assert.match(error.message, /poll aborted$/);
      assert(error.message.length < 180);
      assert(!error.message.includes(sensitiveFixture));
      assert(!error.message.includes("corp-adapter-test-key"));
      assert(!error.message.includes("corp-adapter-test-secret"));
      assert.equal(error.cause, undefined);
      if (expectedGroup) assert(error.message.includes(expectedGroup));
      return true;
    });
  }
  try {
    process.env.ALPACA_API_KEY = "corp-adapter-test-key";
    process.env.ALPACA_API_SECRET = "corp-adapter-test-secret";
    reply({ corporate_actions: {}, next_page_token: null, harmless_metadata: { revision: 1 } });
    assert.deepEqual(await query(), []);
    reply({ corporate_actions: { forward_splits: [], spin_offs: [] }, next_page_token: null });
    assert.deepEqual(await query(), []);
    const split = { symbol: "APH", ex_date: TODAY, old_rate: 1, new_rate: 2, process_date: TODAY, id: "fixture-aph" };
    reply({ corporate_actions: { forward_splits: [split] }, next_page_token: null });
    const parsed = await query();
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].symbol, "APH");
    assert.equal(parsed[0].type, "forward_split");
    assert.equal(parsed[0].exDate, TODAY);
    assert.equal(parsed[0].newRate, 2);
    assert.equal(parsed[0].oldRate, 1);
    assert.deepEqual(parsed[0].raw, split);
    console.log("✓ adapter preserves genuine empty responses, harmless metadata, and valid APH split data");

    reply(sensitiveFixture, 503, true);
    await rejectsSanitized();
    globalThis.fetch = async () => { fetchCalls++; throw new Error(sensitiveFixture); };
    await rejectsSanitized();
    reply(sensitiveFixture, 200, true); // invalid JSON must not become an empty action plan
    await rejectsSanitized();
    console.log("✓ HTTP, network, and JSON failures throw bounded errors without body/credential leakage");

    for (const malformed of [
      null, [], {}, { corporate_actions: null }, { corporate_actions: [] },
      { corporate_actions: { forward_splits: {} } },
      { corporate_actions: { forward_splits: null } }, // official REST schema requires array if present
      { corporate_actions: { forward_splits: [null] } },
      { corporate_actions: { forward_splits: [{}] } },
      { corporate_actions: { forward_splits: [{ ...split, new_rate: "invalid" }] } },
      { corporate_actions: { forward_splits: [{ ...split, old_rate: true }] } },
      { corporate_actions: { forward_splits: [{ ...split, ex_date: "2026-02-30" }] } },
      { corporate_actions: { cash_dividends: [{ symbol: "APH", ex_date: TODAY }] } },
    ]) {
      reply(malformed);
      await rejectsSanitized();
    }
    reply({ corporate_actions: {}, next_page_token: "fixture-next-page" });
    await rejectsSanitized();
    reply({ corporate_actions: { spin_offs: [{ symbol: "APH" }] }, next_page_token: null });
    await rejectsSanitized("spin_offs");
    reply({ corporate_actions: { [sensitiveFixture]: [{ symbol: "APH" }] }, next_page_token: null });
    await rejectsSanitized();
    console.log("✓ malformed rows/groups and incomplete/unsupported snapshots cannot certify an empty poll");

    const db = holding();
    storeCorpPlan(db, splitPlan());
    const stored = getState(db, "corp:plan");
    reply(sensitiveFixture, 503, true);
    await assert.rejects(() => nightlyCorpPoll(db, alpacaCorporateActions, { today: TODAY }), /poll aborted/);
    assert.equal(getState(db, "corp:plan"), stored, "a failed real adapter must preserve previously known split evidence");
    console.log("✓ nightly poll retains its prior plan when the real adapter reports unavailable data");
    assert(fetchCalls > 20);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.ALPACA_API_KEY;
    else process.env.ALPACA_API_KEY = savedKey;
    if (savedSecret === undefined) delete process.env.ALPACA_API_SECRET;
    else process.env.ALPACA_API_SECRET = savedSecret;
  }
}

console.log("all corporate-action containment tests passed");
