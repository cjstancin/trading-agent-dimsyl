// Offline evening halt regressions: memory-only ledger, injected broker/LLM/notification spies.
// No real adapters, credentials, notifications, or paper orders are used by these tests.
import assert from "node:assert/strict";
import { openDb, getState, setState, clearState } from "./v2/db.js";
import { d9, d9str } from "./v2/decimal.js";
import { loadConfig, DEFAULTS_PATH } from "./v2/config.js";
import { seedBook, recordCash } from "./v2/settled-cash.js";
import { ingestFill, ledgerPositions } from "./v2/lots.js";
import type { BrokerOrderRequest, ReadPort } from "./v2/broker.js";
import { reconcileBoot } from "./v2/reconcile.js";
import { ensureBookTables } from "./v2/book/equity.js";
import { ensureBenchTables } from "./v2/book/benchmarks.js";
import { ensureJdgTables, recordVerdict } from "./v2/judgment/counterfactual.js";
import { ensureInsiderTables } from "./v2/sleeves/insider/store.js";
import { writeMeta as writeInsMeta } from "./v2/sleeves/insider/exits.js";
import { runEveningRitual, type EveningDeps } from "./v2/rituals/evening.js";

const TODAY = "2026-08-17";
const EFF = loadConfig(DEFAULTS_PATH, DEFAULTS_PATH + ".no-journal");
type Db = ReturnType<typeof openDb>;
const count = (db: Db, table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
globalThis.fetch = async () => { throw new Error("network forbidden in evening halt tests"); };

function fixture() {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-01");
  ensureBookTables(db);
  ensureBenchTables(db);
  ensureInsiderTables(db);
  ensureJdgTables(db);
  const submits: BrokerOrderRequest[] = [];
  const posts: string[] = [];
  const calls = { llm: 0, cancels: 0, openOrders: 0, filings: 0, corporate: 0, fills: 0 };
  const prices: Record<string, number> = { WLD: 7, INS: 8.4, SPY: 650, IWM: 230, QMOM: 220, NANC: 40, FOREIGN: 10, KNOWN: 10 };
  const read: ReadPort = {
    async getAccount() { return { cash: "5000" }; },
    async getPositions() { return [...ledgerPositions(db)].map(([symbol, qty]) => ({ symbol, qty: d9str(qty) })); },
    async getFillActivities() { calls.fills++; return []; },
    async getSessions() { return ["2026-08-14", TODAY, "2026-08-18"]; },
  };
  const deps: EveningDeps = {
    db, eff: EFF, today: TODAY, mode: "auto", read,
    post: async (text) => { posts.push(text); },
    latestPrice: async (s) => prices[s] ?? null,
    marketDay: async () => ({ open: true, reason: "fixture", via: "fallback", date: TODAY, halfDay: false }),
    broker: {
      async submit(req) { submits.push(req); return { outcome: "accepted", order: { id: `accepted-${submits.length}`, status: "accepted" } }; },
      async queryByClientOrderId() { return null; },
      async getOpenOrders() { calls.openOrders++; return []; },
      async cancelOrder() { calls.cancels++; return true; },
    },
    insEdgar: {
      async getCurrentForm4Atom() { return ""; },
      async getDailyIndex() { calls.filings++; return ""; },
      async getFiling() { throw new Error("unexpected filing lookup"); },
    },
    insCarPrices: { async getCloses() { return []; } },
    corpPort: { async announcements() { calls.corporate++; return []; } },
    llm: { async complete() { calls.llm++; return "invalid fixture reply"; } },
    dailyBars: async () => [],
  };
  return { db, deps, submits, posts, calls, prices };
}

function stopPosition(db: Db, sleeve: "ins" | "wld", symbol = sleeve.toUpperCase()): string {
  ingestFill(db, { id: `seed-${symbol}`, symbol, side: "buy", qty9: d9("10"), price9: d9("10"), ts: "2026-08-01T14:31:00Z", sleeve });
  recordCash(db, { ts: "2026-08-01T14:31:00Z", kind: "buy", symbol, amount9: -d9("100"), settlesOn: "2026-08-01", ref: `seed-${symbol}` });
  const event = sleeve === "ins"
    ? { ts: "2026-08-14T20:00:00Z", price9: "8.4", stop9: "8.5" }
    : {
      schema: "wld-stop-fired-v1", sleeve, symbol, firedTs: "2026-08-14T20:00:00Z", firedPrice: "7",
      source: "bot_ratchet", entryPrice: 10, peak: 12, atrStop: 7.2, thesis: "fixture thesis",
      invalidationLevel: 8, whatWouldChangeMyMind: "margin loss", holdingPeriod: "weeks", enteredOn: "2026-08-01",
    };
  if (sleeve === "ins") {
    writeInsMeta(db, symbol, {
      clusterId: "fixture", entryDate: "2026-08-01", horizonTradingDays: 1, clockResets: 0,
      maxExitDate: TODAY, sector: null, participants: [],
    }); // unhalted insider exit is DUE, so the halt test exercises a real would-sell path
  }
  const raw = JSON.stringify(event);
  setState(db, `${sleeve}:stop_fired:${symbol}`, raw);
  return raw;
}

const foreignFill = (id: string) => ({
  id, order_id: `manual-${id}`, symbol: "FOREIGN", side: "buy", qty: "1", price: "10", transaction_time: `${TODAY}T20:01:00Z`,
});

async function test(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`  ✓ ${name}`);
}

await test("book halt preserves decisions while known fills, external benchmarks and observations continue", async () => {
  const f = fixture();
  try {
    const ins = stopPosition(f.db, "ins");
    const wld = stopPosition(f.db, "wld");
    setState(f.db, "halt:book", "unresolved account mismatch");
    setState(f.db, "anc:pending_rebuild", "owed");
    setState(f.db, "mom:executed-month", "2026-07");
    const meta = f.db.prepare("SELECT * FROM position_meta").all();
    f.db.prepare(`INSERT INTO order_intents(client_order_id,sleeve,symbol,intent,date,seq,side,order_type,status,config_version,broker_order_id)
      VALUES('known-coid','mom','KNOWN','buy',?,1,'buy','market','submitted','test','known-order')`).run(TODAY);
    f.deps.read.getFillActivities = async () => {
      f.calls.fills++;
      return [{ ...foreignFill("known-fill"), symbol: "KNOWN", order_id: "known-order" }];
    };
    recordVerdict(f.db, {
      ts: "2026-07-01T20:00:00Z", sleeve: "wld", symbol: "WLD", inputHash: "historical", votesJson: "[]",
      cls: "market_noise", action: "hold_with_floor", entryPrice9: d9("10"), verdictPrice9: d9("8"),
      stopPrice9: d9("8"), qty9: d9("10"), proxyPrice9: d9("600"), configVersion: "test",
    });
    const res = await runEveningRitual(f.deps);
    assert.equal(res.ok, true, JSON.stringify(res.steps));
    assert.equal(res.halted, true);
    assert.equal(res.halts?.book, "unresolved account mismatch");
    assert.equal(f.submits.length, 0);
    assert.equal(f.calls.llm, 0);
    assert.equal(count(f.db, "jdg_verdicts"), 1); // historical verdict only
    assert.equal(count(f.db, "jdg_outcomes"), 1); // historical measurement remains allowed
    assert.equal(count(f.db, "approvals"), 0);
    assert.equal(getState(f.db, "ins:stop_fired:INS"), ins);
    assert.equal(getState(f.db, "wld:stop_fired:WLD"), wld);
    assert.deepEqual(f.db.prepare("SELECT * FROM position_meta").all(), meta);
    assert.equal(getState(f.db, "anc:pending_rebuild"), "owed");
    assert.equal(getState(f.db, "mom:executed-month"), "2026-07");
    assert.equal(ledgerPositions(f.db).get("KNOWN"), d9("1"));
    assert.equal((f.db.prepare("SELECT amount9 FROM cash_events WHERE ref='known-fill'").get() as { amount9: string }).amount9, "-10");
    assert.equal(count(f.db, "book_marks"), 0);
    assert.equal(f.db.prepare("SELECT * FROM bench_marks WHERE series LIKE 'sleeve:%'").all().length, 0);
    assert.equal(f.db.prepare("SELECT * FROM bench_marks WHERE series='SPY'").all().length, 1);
    assert.equal(f.calls.filings, 1);
    assert.equal(f.calls.corporate, 1);
    assert.equal(f.calls.openOrders + f.calls.cancels, 0); // no accidental reconcile watchdog
    assert(f.posts.some((p) => p.includes("evening") && p.includes("HALTED")));
  } finally { f.db.close(); }
});

await test("insider-only halt preserves its due exit and stop event; unhalted wildcard floor still sells", async () => {
  const f = fixture();
  try {
    const ins = stopPosition(f.db, "ins");
    stopPosition(f.db, "wld");
    setState(f.db, "halt:ins", "insider mismatch");
    const res = await runEveningRitual(f.deps);
    assert.equal(res.ok, true, JSON.stringify(res.steps));
    assert.deepEqual(Object.keys(res.halts ?? {}), ["ins"]);
    assert.equal(f.submits.length, 1);
    assert.equal(f.submits[0].symbol, "WLD");
    assert.equal(f.submits[0].side, "sell");
    assert.equal(getState(f.db, "ins:stop_fired:INS"), ins);
    assert.equal(getState(f.db, "wld:stop_fired:WLD"), null);
    assert.equal(f.calls.llm, 0);
    assert.equal(count(f.db, "jdg_verdicts"), 1);
    assert.equal(f.db.prepare("SELECT * FROM order_intents WHERE sleeve='ins'").all().length, 0);
    assert.equal(count(f.db, "book_marks"), 0); // no authoritative valuation on mismatched quantities
  } finally { f.db.close(); }
});

await test("new untagged fills latch halt and approval before broken notifications, with durable dedup", async () => {
  const f = fixture();
  try {
    const raw = stopPosition(f.db, "wld");
    f.deps.read.getFillActivities = async (after) => after ? [] : [foreignFill("foreign-1")];
    f.deps.post = async () => {
      assert(getState(f.db, "halt:book"), "halt must exist before the first notification");
      assert.equal(count(f.db, "approvals"), 1, "approval must exist before the first notification");
      throw new Error("fixture Discord unavailable");
    };
    const res = await runEveningRitual(f.deps);
    assert.equal(res.ok, false);
    assert.equal(res.halted, true);
    assert.equal(f.submits.length, 0);
    assert.equal(getState(f.db, "wld:stop_fired:WLD"), raw);
    assert.equal(getState(f.db, "fills_cursor"), "foreign-1");
    const reason = getState(f.db, "halt:book");
    f.deps.post = async (text) => { f.posts.push(text); };
    f.db.prepare("UPDATE approvals SET status='approved'").run();
    clearState(f.db, "fills_cursor"); // even a replay of already-ingested broker data is harmless
    await runEveningRitual(f.deps);
    assert.equal(count(f.db, "approvals"), 1);
    assert.equal(getState(f.db, "halt:book"), reason);
    const nextMorning = await reconcileBoot(f.db, f.deps.broker, f.deps.read, { now: new Date("2026-08-18T14:00:00Z") });
    assert.equal(nextMorning.ok, true); // ledger/broker match and no NEW untagged fills
    assert.equal(nextMorning.untaggedFills.length, 0);
    assert.equal(getState(f.db, "halt:book"), reason); // prior evening incident remains latched
  } finally { f.db.close(); }
});

await test("failed replay defers decisions and valuation but a fetch outage does not create a sticky halt", async () => {
  const f = fixture();
  try {
    const raw = stopPosition(f.db, "wld");
    f.deps.read.getFillActivities = async () => { throw new Error("fixture broker unavailable"); };
    const res = await runEveningRitual(f.deps);
    assert.equal(res.ok, false);
    assert.equal(res.halted, false);
    assert.equal(getState(f.db, "halt:book"), null);
    assert.equal(f.submits.length + f.calls.llm, 0);
    assert.equal(getState(f.db, "wld:stop_fired:WLD"), raw);
    assert.equal(count(f.db, "jdg_verdicts") + count(f.db, "book_marks"), 0);
    assert.equal(f.calls.filings, 1);
    assert.equal(f.calls.corporate, 1);
    assert(f.posts.some((p) => p.includes("REPLAY INCOMPLETE")));
    // A later clean replay resumes normally without inventing a manual-clear requirement.
    f.deps.read.getFillActivities = async () => [];
    const retry = await runEveningRitual(f.deps);
    assert.equal(retry.ok, true, JSON.stringify(retry.steps));
    assert.equal(f.submits.length, 1);
    assert.equal(count(f.db, "book_marks"), 1);
  } finally { f.db.close(); }
});

await test("partial replay failure cannot swallow an earlier untagged incident", async () => {
  const f = fixture();
  try {
    const raw = stopPosition(f.db, "wld");
    f.deps.read.getFillActivities = async () => [foreignFill("partial-1"), { ...foreignFill("partial-2"), qty: "not-a-number" }];
    const res = await runEveningRitual(f.deps);
    assert.equal(res.ok, false);
    assert.equal(res.halted, true);
    assert.equal(getState(f.db, "fills_cursor"), "partial-1");
    assert(getState(f.db, "halt:book")?.includes("partial-1"));
    assert.equal(count(f.db, "approvals"), 1);
    assert.deepEqual(JSON.parse((f.db.prepare("SELECT payload FROM approvals").get() as { payload: string }).payload).untaggedFills, ["partial-1"]);
    assert.equal(f.submits.length + f.calls.llm, 0);
    assert.equal(getState(f.db, "wld:stop_fired:WLD"), raw);
    assert.equal(count(f.db, "book_marks"), 0);
  } finally { f.db.close(); }
});

await test("new untagged evidence preserves an existing operator halt reason", async () => {
  const f = fixture();
  try {
    setState(f.db, "halt:book", "operator investigating quantities");
    f.deps.read.getFillActivities = async () => [foreignFill("second-incident")];
    await runEveningRitual(f.deps);
    assert.equal(getState(f.db, "halt:book"), "operator investigating quantities");
    assert.equal(count(f.db, "approvals"), 1);
  } finally { f.db.close(); }
});

await test("halt arriving during a thesis price lookup preserves the event before classification", async () => {
  const f = fixture();
  try {
    const raw = stopPosition(f.db, "wld");
    let reads = 0;
    f.deps.latestPrice = async (symbol) => {
      if (symbol === "WLD" && ++reads === 2) setState(f.db, "halt:wld", "operator paused during price read");
      return f.prices[symbol] ?? null;
    };
    const res = await runEveningRitual(f.deps);
    assert.equal(res.halted, true);
    assert.equal(f.submits.length + f.calls.llm, 0);
    assert.equal(count(f.db, "jdg_verdicts"), 0);
    assert.equal(getState(f.db, "wld:stop_fired:WLD"), raw);
  } finally { f.db.close(); }
});

await test("pending dividend evidence defers certified performance without halting the book", async () => {
  const f = fixture();
  try {
    setState(f.db, "corp:pending:div:AMAT:2026-08-20", JSON.stringify({status:"pending",symbol:"AMAT",exDate:"2026-08-20"}));
    const res = await runEveningRitual(f.deps);
    assert.equal(getState(f.db, "halt:book"), null);
    assert.equal(count(f.db, "book_marks"), 0);
    assert.ok(res.steps.some(s => s.name === "equity-mark" && s.detail?.includes("unverified dividend")));
  } finally { f.db.close(); }
});

console.log("evening halt safety: 8 scenarios passed");
