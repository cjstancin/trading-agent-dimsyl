// Offline tests — v2 ritual orchestrators (morning / evening / weekly / statement / anchor-filing).
// :memory: db, mock broker + read ports, fixture market ports, scripted LLM, captured Discord
// sender (postBill is INJECTED — the real one is never called here). No network, no env.
import { openDb, getState, setState } from "./v2/db.js";
import { d9, d9str } from "./v2/decimal.js";
import { loadConfig, DEFAULTS_PATH } from "./v2/config.js";
import { seedBook, recordCash } from "./v2/settled-cash.js";
import { ingestFill, ledgerPositions } from "./v2/lots.js";
import type { BrokerPort, BrokerOrderRequest, SubmitResult, ReadPort } from "./v2/broker.js";
import type { MarketDayCheck } from "./market-calendar.js";
import { markEquity } from "./v2/book/equity.js";
import { recordExit } from "./v2/book/watchlist.js";
import type { LlmPort, LlmRole } from "./v2/judgment/llm-port.js";
import { recordVerdict, recordOutcome } from "./v2/judgment/counterfactual.js";
import type { Cluster } from "./v2/sleeves/insider/cluster.js";
import { ensureInsiderTables, upsertCluster } from "./v2/sleeves/insider/store.js";
import { recordSignal } from "./v2/sleeves/insider/shadow.js";
import { writeMeta as writeInsMeta } from "./v2/sleeves/insider/exits.js";
import type { MarketPort, SectorPort } from "./v2/sleeves/insider/ports.js";
import { saveMeta as saveWldMeta } from "./v2/sleeves/wildcard/store.js";
import type { StopFiredEvent, WldPosMeta } from "./v2/sleeves/wildcard/types.js";
import { ensureMomTables } from "./v2/sleeves/momentum/schema.js";
import type { AnchorPorts } from "./v2/sleeves/anchor/index.js";
import { runMorningRitual, type MorningDeps } from "./v2/rituals/morning.js";
import { runEveningRitual, type EveningDeps } from "./v2/rituals/evening.js";
import { runWeeklyRitual, type WeeklyDeps } from "./v2/rituals/weekly.js";
import { runStatementRitual } from "./v2/rituals/statement.js";
import { runAnchorFilingRitual } from "./v2/rituals/anchor-filing.js";
import { storeCorpPlan } from "./v2/rituals/corp-actions.js";
import { prevMonthKey, latestQuarterEnd } from "./v2/rituals/time.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

const EFF = loadConfig(DEFAULTS_PATH, DEFAULTS_PATH + ".no-journal");
const TODAY = "2026-08-17"; // a Monday-adjacent weekday; tests pin weekday explicitly

// ---------- shared mocks -----------------------------------------------------------------------

function mockBroker(): BrokerPort & { submits: BrokerOrderRequest[] } {
  const submits: BrokerOrderRequest[] = [];
  return {
    submits,
    async submit(req): Promise<SubmitResult> {
      submits.push(req);
      return { outcome: "accepted", order: { id: `oid-${submits.length}`, status: "accepted" } };
    },
    async queryByClientOrderId(coid) {
      // Momentum polls sells to terminal; any order we accepted reports filled immediately.
      return submits.some((s) => s.client_order_id === coid) ? { id: "oid-x", status: "filled" } : null;
    },
    async getOpenOrders() { return []; },
    async cancelOrder() { return true; },
  };
}

const SESSIONS = ["2026-08-14", "2026-08-15", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"];

/** ReadPort whose positions mirror the ledger at call time (reconcile stays clean unless a test
 *  overrides positions to force a mismatch). */
function mockRead(db: ReturnType<typeof openDb>, over: Partial<{ positions: unknown[]; fills: unknown[]; cash: string }> = {}): ReadPort {
  return {
    async getAccount() { return { cash: over.cash ?? "5000" }; },
    async getPositions() {
      if (over.positions) return over.positions as never[];
      return [...ledgerPositions(db).entries()].map(([symbol, qty]) => ({ symbol, qty: d9str(qty) }));
    },
    async getFillActivities(afterId?: string) {
      return ((over.fills ?? []) as { id: string }[]).filter((f) => !afterId || String(f.id) > afterId) as never[];
    },
    async getSessions() { return SESSIONS; },
  };
}

function capture(): { posts: string[]; post: (t: string) => Promise<void> } {
  const posts: string[] = [];
  return { posts, post: async (t: string) => { posts.push(t); } };
}

function mockLlm(script: Partial<Record<LlmRole, string[]>>): LlmPort & { calls: { role: LlmRole; prompt: string }[] } {
  const queues: Record<string, string[]> = { extract: [...(script.extract ?? [])], brief: [...(script.brief ?? [])], judge: [...(script.judge ?? [])] };
  const calls: { role: LlmRole; prompt: string }[] = [];
  return { calls, async complete(role, prompt) { calls.push({ role, prompt }); return queues[role].shift() ?? "NO_SCRIPTED_REPLY"; } };
}

const openDay: MarketDayCheck = { open: true, reason: "test", via: "fallback", date: TODAY, halfDay: false };

function goodInsMarket(spreadBad: Set<string> = new Set()): MarketPort {
  const bars = Array.from({ length: 25 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`, close9: d9("10"), volume9: d9("200000"),
  }));
  return {
    async getDailyBars() { return bars; },
    async getQuote(symbol) {
      return spreadBad.has(symbol) ? { bid9: d9("9"), ask9: d9("11") } : { bid9: d9("9.99"), ask9: d9("10.01") };
    },
    async getMarketCap9() { return d9("100000000"); },
    async getAsset() { return { fractionable: true, exchange: "NASDAQ", tradable: true }; },
  };
}
const nullSector: SectorPort = { async getSector() { return null; } };

function mkCluster(symbol: string, score: number): Cluster {
  const participants = ["1001", "1002", "1003"].map((cik, i) => ({
    cik, name: `P${cik}`, isOfficer: i === 0, isDirector: i !== 0, isTenPercentOwner: false,
    officerTitle: i === 0 ? "CFO" : null, value9: "40000", shares9: "4000", deltaOwnFrac: 1, firstEver: true,
  }));
  return {
    clusterId: `ins:${symbol}:2026-08-15`, symbol, issuerCik: "999", windowStart: "2026-08-06",
    windowEnd: "2026-08-15", participants, aggregate9: d9("120000"), officerCount: 1, directorCount: 2, score,
  };
}

function seedPendingSignal(db: ReturnType<typeof openDb>, symbol: string, score: number): void {
  ensureInsiderTables(db);
  const c = mkCluster(symbol, score);
  upsertCluster(db, c, "t");
  recordSignal(db, c, "2026-08-15");
}

function mkMorningDeps(db: ReturnType<typeof openDb>, over: Partial<MorningDeps> & { prices?: Record<string, number | null> } = {}): {
  deps: MorningDeps; broker: ReturnType<typeof mockBroker>; posts: string[];
} {
  const broker = (over.broker as ReturnType<typeof mockBroker>) ?? mockBroker();
  const cap = capture();
  const prices = over.prices ?? {};
  const deps: MorningDeps = {
    db, eff: EFF, mode: "auto", today: TODAY, post: over.post ?? cap.post,
    latestPrice: async (s) => prices[s] ?? null,
    broker,
    read: mockRead(db),
    marketDay: async () => openDay,
    leiReading: () => null,
    spyAbove200dma: async () => true,
    dailyBars: async () => [],
    insMarket: goodInsMarket(),
    insSector: nullSector,
    momPrices: null,
    wldPorts: {
      pool: { async momentumTop() { return []; }, async insiderLiveClusters() { return []; }, async anchorTop5s() { return []; } },
      card: { async fundamentals() { return null; }, async newsClaims() { return []; }, async pricePath() { return null; } },
      pick: { async rankPool() { throw new Error("no pick model in tests"); } },
    },
    ancPrices: { async latestPrice9() { return null; }, async priceOn9() { return null; } },
    weekday: () => 2, // not Monday → wildcard weekly skipped unless a test overrides
    nowEtMinutes: () => 11 * 60,
    sleep: async () => {},
    pollTries: 2,
    pollDelayMs: 0,
    ...over,
  };
  return { deps, broker, posts: (over.post ? [] : cap.posts) };
}

function mkEveningDeps(db: ReturnType<typeof openDb>, over: Partial<EveningDeps> & { prices?: Record<string, number | null> } = {}): {
  deps: EveningDeps; broker: ReturnType<typeof mockBroker>; posts: string[]; llm: ReturnType<typeof mockLlm>;
} {
  const broker = (over.broker as ReturnType<typeof mockBroker>) ?? mockBroker();
  const cap = capture();
  const prices = over.prices ?? {};
  const llm = (over.llm as ReturnType<typeof mockLlm>) ?? mockLlm({});
  const deps: EveningDeps = {
    db, eff: EFF, mode: "auto", today: TODAY, post: over.post ?? cap.post,
    latestPrice: async (s) => prices[s] ?? null,
    broker,
    read: mockRead(db),
    marketDay: async () => openDay,
    insEdgar: {
      async getCurrentForm4Atom() { return ""; },
      async getDailyIndex() { return ""; },
      async getFiling() { throw new Error("no filings in tests"); },
    },
    insCarPrices: { async getCloses() { return []; } },
    corpPort: { async announcements() { return []; } },
    llm,
    dailyBars: async () => [],
    ...over,
  };
  return { deps, broker, posts: (over.post ? [] : cap.posts), llm };
}

// ---------- morning ----------------------------------------------------------------------------

console.log("v2 rituals — morning: mode off + market-closed gates:");
await (async () => {
  const db = openDb(":memory:");
  const { deps } = mkMorningDeps(db);
  const off = await runMorningRitual({ ...deps, mode: "off" });
  check("mode=off skips everything", off.skipped === "mode=off" && off.steps.length === 0);
  const { deps: d2, broker, posts } = mkMorningDeps(db, {
    marketDay: async () => ({ ...openDay, open: false, reason: "holiday" }),
  });
  const closed = await runMorningRitual(d2);
  check("market-closed skips with a note", closed.skipped === "holiday" && broker.submits.length === 0 && posts.some((p) => p.includes("market closed")));
})();

console.log("v2 rituals — morning: reconcile mismatch halts and posts:");
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", TODAY);
  const { deps, broker, posts } = mkMorningDeps(db, {
    read: mockRead(db, { positions: [{ symbol: "GHOST", qty: "5" }] }),
    prices: { SGOV: 100 },
  });
  const res = await runMorningRitual(deps);
  check("halted, nothing traded", res.halted === true && broker.submits.length === 0);
  check("escalation posted", posts.some((p) => p.includes("Needs your call") && p.includes("mismatch")));
  check("book halt state set", getState(db, "halt:book") !== null);
})();

console.log("v2 rituals — morning: dial downgrade trims + sweep runs last:");
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", TODAY);
  setState(db, "dial:lei", JSON.stringify({ position: "engage", asOf: TODAY }));
  ingestFill(db, { id: "m1", symbol: "NVDA", side: "buy", qty9: d9("10"), price9: d9("100"), ts: "2026-08-10T14:31:00Z", sleeve: "mom" });
  const { deps, broker, posts } = mkMorningDeps(db, {
    leiReading: () => ({ stage: "pullback", asOf: TODAY }),
    prices: { NVDA: 300, SGOV: 100 },
  });
  const res = await runMorningRitual(deps);
  check("ritual ok", res.ok === true, JSON.stringify(res.steps));
  const trim = broker.submits.find((s) => s.symbol === "NVDA");
  // mom sleeve 2000 × 0.55 = 1100 target; value 3000 → excess 1900 → qty 1900/300
  check("downgrade trim placed via gateway", !!trim && trim.side === "sell" && trim.client_order_id?.startsWith("mom:NVDA:trim:"), JSON.stringify(trim));
  check("trim qty = excess/price", trim?.qty === "6.333333333", trim?.qty);
  check("dial change posted", posts.some((p) => p.includes("engage") && p.includes("pullback")));
  const last = broker.submits[broker.submits.length - 1];
  check("sweep runs LAST with remaining cash", last.symbol === "SGOV" && last.side === "buy" && last.notional === "4950", JSON.stringify(last));
})();

console.log("v2 rituals — morning: brake tier-1 halves momentum sizing:");
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", TODAY);
  setState(db, "brake:peak9", d9("5500").toString()); // book equity 5000 vs peak 5500 → dd 9.09% → tier 1
  ensureMomTables(db);
  db.prepare("INSERT INTO mom_ranks(month, symbol, score, dollar_volume, fip, mom_rank, final_rank, veto) VALUES(?,?,?,?,?,?,?,?)")
    .run("2026-07", "AAA", 0.5, 1e6, 0.4, 1, 1, null);
  const { deps, broker, posts } = mkMorningDeps(db, { prices: { AAA: 50 } });
  const res = await runMorningRitual(deps);
  check("ritual ok", res.ok === true, JSON.stringify(res.steps));
  const buy = broker.submits.find((s) => s.symbol === "AAA");
  // perName = 2000/10 = 200; deployScalar = 1.0 (engage fallback) × 0.5 (tier 1) → $100
  check("new-buy notional halved by tier-1", buy?.notional === "100", buy?.notional);
  check("execution month marked", getState(db, "mom:executed-month") === "2026-07");
  check("brake tier change posted", posts.some((p) => p.includes("brake tier 0 → 1")));
  check("sweep skipped with a note when SGOV unpriced", posts.some((p) => p.includes("SGOV") && p.includes("NO_PRICE")));
})();

console.log("v2 rituals — morning: insider entries exempt from dial scalar + skip notes:");
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", TODAY);
  seedPendingSignal(db, "GOOD", 2);
  seedPendingSignal(db, "BADQ", 1);
  const { deps, broker, posts } = mkMorningDeps(db, {
    leiReading: () => ({ stage: "caution", asOf: TODAY }), // dial 0.7 — must NOT touch insider sizing
    insMarket: goodInsMarket(new Set(["BADQ"])),
    prices: { IWM: 230, SGOV: 100 },
  });
  const res = await runMorningRitual(deps);
  check("ritual ok", res.ok === true, JSON.stringify(res.steps));
  const entry = broker.submits.find((s) => s.symbol === "GOOD");
  check("insider slot notional NOT dial-scaled", entry?.notional === "600", entry?.notional); // slotNotional9(1250) = $600, not 0.7×
  check("failed gate produces a skip note", posts.some((p) => p.includes("BADQ") && p.includes("SPREAD_GATE")));
  const shadow = db.prepare("SELECT funded, skip_reason FROM ins_signals WHERE symbol='BADQ'").get() as { funded: number; skip_reason: string };
  check("failed gate lands in the shadow book", shadow.funded === 0 && shadow.skip_reason === "SPREAD_GATE");
  const last = broker.submits[broker.submits.length - 1];
  check("sweep last, net of the entry's open buy reservation", last.symbol === "SGOV" && last.notional === "4350", JSON.stringify(last));
})();

console.log("v2 rituals — morning: mode gated computes but places nothing:");
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", TODAY);
  setState(db, "dial:lei", JSON.stringify({ position: "engage", asOf: TODAY }));
  ingestFill(db, { id: "g1", symbol: "NVDA", side: "buy", qty9: d9("10"), price9: d9("100"), ts: "2026-08-10T14:31:00Z", sleeve: "mom" });
  ensureMomTables(db);
  db.prepare("INSERT INTO mom_ranks(month, symbol, score, dollar_volume, fip, mom_rank, final_rank, veto) VALUES(?,?,?,?,?,?,?,?)")
    .run("2026-07", "AAA", 0.5, 1e6, 0.4, 1, 1, null);
  seedPendingSignal(db, "GOOD", 2);
  const { deps, broker, posts } = mkMorningDeps(db, {
    mode: "gated",
    leiReading: () => ({ stage: "pullback", asOf: TODAY }),
    prices: { NVDA: 300, AAA: 50, IWM: 230, SGOV: 100 },
  });
  const res = await runMorningRitual(deps);
  check("ritual ok", res.ok === true, JSON.stringify(res.steps));
  check("NOTHING placed in gated mode", broker.submits.length === 0, String(broker.submits.length));
  check("would-trim posted", posts.some((p) => p.includes("would TRIM") && p.includes("NVDA")));
  check("would-rebalance posted", posts.some((p) => p.includes("would rebalance")));
  check("would-buy insider posted, signal kept pending", posts.some((p) => p.includes("would BUY") && p.includes("GOOD"))
    && (db.prepare("SELECT entry_date FROM ins_signals WHERE symbol='GOOD'").get() as { entry_date: string | null }).entry_date === null);
  check("would-sweep posted", posts.some((p) => p.includes("sweep would buy")));
  check("momentum month NOT marked executed", getState(db, "mom:executed-month") === null);
})();

// ---------- evening ----------------------------------------------------------------------------

console.log("v2 rituals — evening: equity mark with missing-price fallback + benches:");
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-14");
  ingestFill(db, { id: "e1", symbol: "AAPL", side: "buy", qty9: d9("10"), price9: d9("200"), ts: "2026-08-14T14:31:00Z", sleeve: "mom" });
  recordCash(db, { ts: "2026-08-14T14:31:00Z", kind: "buy", symbol: "AAPL", amount9: -d9("2000"), settlesOn: "2026-08-14", ref: "e1" });
  markEquity(db, "2026-08-14", new Map([["AAPL", d9("200")]])); // prior mark carries the fallback price
  const { deps, posts } = mkEveningDeps(db, { prices: { AAPL: null, SPY: 650, QMOM: 220, IWM: 230, NANC: 40 } });
  const res = await runEveningRitual(deps);
  check("ritual ok", res.ok === true, JSON.stringify(res.steps));
  const mark = db.prepare("SELECT equity9, positions_json FROM book_marks WHERE date=?").get(TODAY) as { equity9: string; positions_json: string };
  check("mark written with prior-price fallback", !!mark && mark.equity9 === "5000" && mark.positions_json.includes('"price9":"200"'));
  check("fallback flagged in a note", posts.some((p) => p.includes("AAPL") && p.includes("previous mark")));
  const spy = db.prepare("SELECT value9 FROM bench_marks WHERE date=? AND series='SPY'").get(TODAY) as { value9: string };
  check("SPY close recorded", spy?.value9 === "650");
  const sleeveMom = db.prepare("SELECT value9 FROM bench_marks WHERE date=? AND series='sleeve:mom'").get(TODAY) as { value9: string };
  check("per-sleeve mark recorded", !!sleeveMom);
  check("summary posted", posts.some((p) => p.includes("evening")));
})();

console.log("v2 rituals — evening: stop_fired → thesis-check → sell_now (floor) path:");
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-10");
  ingestFill(db, { id: "w1", symbol: "XYZ", side: "buy", qty9: d9("10"), price9: d9("10"), ts: "2026-08-10T14:31:00Z", sleeve: "wld" });
  recordCash(db, { ts: "2026-08-10T14:31:00Z", kind: "buy", symbol: "XYZ", amount9: -d9("100"), settlesOn: "2026-08-10", ref: "w1" });
  const event: StopFiredEvent = {
    schema: "wld-stop-fired-v1", sleeve: "wld", symbol: "XYZ", firedTs: "2026-08-16T15:00:00Z",
    firedPrice: "7", source: "bot_ratchet", entryPrice: 10, peak: 12, atrStop: 7.2,
    thesis: "test thesis", invalidationLevel: 8, whatWouldChangeMyMind: "margin compression",
    holdingPeriod: "weeks", enteredOn: "2026-08-10",
  };
  const meta: WldPosMeta = {
    schema: "wld-pos-v1", thesis: "test thesis", invalidationLevel: 8, conviction: "medium",
    holdingPeriod: "weeks", whatWouldChangeMyMind: "margin compression", enteredOn: "2026-08-10",
    pickRank: 1, entryPrice: 10, peak: 12, atrStop: 7.2, stopFired: event,
  };
  saveWldMeta(db, "XYZ", meta);
  setState(db, "wld:stop_fired:XYZ", JSON.stringify(event));
  const { deps, broker, posts, llm } = mkEveningDeps(db, { prices: { XYZ: 7, SPY: 650, IWM: 230, QMOM: 220, NANC: 40 } });
  const res = await runEveningRitual(deps);
  check("ritual ok", res.ok === true, JSON.stringify(res.steps));
  const sell = broker.submits.find((s) => s.symbol === "XYZ");
  check("sleeve sell placed (floor-enforced sell_now)", !!sell && sell.side === "sell" && sell.qty === "10" && sell.client_order_id?.startsWith("wld:XYZ:sell:"));
  check("exit recorded to the watchlist", (db.prepare("SELECT COUNT(*) AS n FROM wl_exits WHERE symbol='XYZ'").get() as { n: number }).n === 1);
  check("event cleared", getState(db, "wld:stop_fired:XYZ") === null);
  const verdict = db.prepare("SELECT class, action FROM jdg_verdicts WHERE symbol='XYZ'").get() as { class: string; action: string };
  check("verdict logged: floor_enforced sell_now", verdict?.class === "floor_enforced" && verdict?.action === "sell_now");
  check("floor path needs no model call", llm.calls.length === 0, String(llm.calls.length));
  check("sell note posted", posts.some((p) => p.includes("XYZ") && p.includes("SELL")));
})();

console.log("v2 rituals — evening: thesis-check escalate path writes approvals + clears event:");
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-06");
  ingestFill(db, { id: "i1", symbol: "KVHI", side: "buy", qty9: d9("50"), price9: d9("10"), ts: "2026-08-06T14:31:00Z", sleeve: "ins" });
  recordCash(db, { ts: "2026-08-06T14:31:00Z", kind: "buy", symbol: "KVHI", amount9: -d9("500"), settlesOn: "2026-08-06", ref: "i1" });
  writeInsMeta(db, "KVHI", {
    clusterId: "ins:KVHI:2026-08-05", entryDate: "2026-08-06", horizonTradingDays: 126,
    clockResets: 0, maxExitDate: "2027-05-06", sector: null, participants: [],
  });
  setState(db, "ins:stop_fired:KVHI", JSON.stringify({ ts: "2026-08-16T20:00:00Z", price9: "8.4", stop9: "8.5" }));
  const BEAR = JSON.stringify({ impairment_case: "controls broken", disconfirming_evidence_needed: "clean audit", citations: [0], severity: "high" });
  const BULL = JSON.stringify({ intact_case: "insiders kept buying", citations: [], confidence: "medium" });
  const VOTE = (cls: string) => JSON.stringify({ class: cls, probability: "medium", citations: [] });
  const llm = mockLlm({ brief: [BEAR, BULL], judge: [VOTE("thesis_break"), VOTE("market_noise"), VOTE("market_noise")] });
  const { deps, broker, posts } = mkEveningDeps(db, { llm, prices: { KVHI: 8.4, IWM: 230, SPY: 650, QMOM: 220, NANC: 40 } });
  const res = await runEveningRitual(deps);
  check("ritual ok", res.ok === true, JSON.stringify(res.steps));
  check("thesis-check invoked the model", llm.calls.length === 5, String(llm.calls.length)); // 2 briefs + 3 judges
  check("no sell on a single-source break vote", !broker.submits.some((s) => s.symbol === "KVHI"));
  const appr = db.prepare("SELECT kind FROM approvals WHERE kind='thesis-escalation'").all();
  check("escalation approvals row written", appr.length === 1);
  check("event cleared after escalation", getState(db, "ins:stop_fired:KVHI") === null);
  check("escalation posted", posts.some((p) => p.includes("Needs your call") && p.includes("KVHI")));
})();

// ---------- weekly -----------------------------------------------------------------------------

console.log("v2 rituals — weekly: watchlist + kill-switch + digest + explains:");
const weeklyDb = openDb(":memory:");
await (async () => {
  const db = weeklyDb;
  seedBook(db, "5000", "2026-08-01");
  recordExit(db, { ts: "2026-08-10T15:00:00Z", sleeve: "mom", symbol: "LMND", reason: "rank_out", exitPrice9: d9("10"), qty9: d9("5") });
  // Kill-switch (a): a hold verdict later −80%+ from entry with bear evidence on record.
  const vid = recordVerdict(db, {
    ts: "2026-05-01T00:00:00Z", sleeve: "wld", symbol: "DOOM", inputHash: "h",
    votesJson: JSON.stringify([{ class: "thesis_break", probability: "high", citations: [] }]),
    cls: "thesis_break", action: "escalate_hold", entryPrice9: d9("10"), verdictPrice9: d9("8"),
    stopPrice9: d9("8"), qty9: d9("5"), proxyPrice9: d9("100"), bearSeverity: "high", configVersion: "t",
  });
  recordOutcome(db, vid, 1, "2026-06-01", d9("1.5"), d9("100"));
  const cap = capture();
  const llm = mockLlm({ brief: ["Quiet week: one watchlist add, no trades, brake tier 0."] });
  const deps: WeeklyDeps = {
    db, eff: EFF, mode: "auto", today: TODAY, post: cap.post,
    latestPrice: async (s) => ({ LMND: 12, SPY: 650 } as Record<string, number>)[s] ?? null,
    llm, momPorts: null, ancPorts: null,
  };
  setState(db, "mom:signal-month", prevMonthKey(TODAY)); // month already ranked → step skips cleanly
  const res = await runWeeklyRitual(deps);
  check("ritual ok", res.ok === true, JSON.stringify(res.steps));
  const wl = db.prepare("SELECT weeks_above FROM wl_exits WHERE symbol='LMND'").get() as { weeks_above: number };
  check("watchlist check counted a week above exit", wl?.weeks_above === 1);
  check("kill-switch approvals row filed", db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind='jdg-kill-switch'").get() !== undefined
    && (db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind='jdg-kill-switch'").get() as { n: number }).n >= 1);
  check("judgment reverted to mechanical", getState(db, "judg:mode") === "mechanical");
  check("kill-switch escalation posted", cap.posts.some((p) => p.includes("MECHANICAL")));
  check("digest posted", cap.posts.some((p) => p.includes("Sunday digest")));
  check("Bill explains posted from the brief call", cap.posts.some((p) => p.includes("Bill explains") && p.includes("Quiet week")));
})();

console.log("v2 rituals — weekly→evening: mechanical mode honored on the next thesis event:");
await (async () => {
  const db = weeklyDb; // judg:mode=mechanical persisted by the weekly run above
  ingestFill(db, { id: "w2", symbol: "MECH", side: "buy", qty9: d9("10"), price9: d9("10"), ts: "2026-08-10T14:31:00Z", sleeve: "wld" });
  recordCash(db, { ts: "2026-08-10T14:31:00Z", kind: "buy", symbol: "MECH", amount9: -d9("100"), settlesOn: "2026-08-10", ref: "w2" });
  const event: StopFiredEvent = {
    schema: "wld-stop-fired-v1", sleeve: "wld", symbol: "MECH", firedTs: "2026-08-16T15:00:00Z",
    firedPrice: "9", source: "broker_fill", entryPrice: 10, peak: 11, atrStop: 9.1,
    thesis: "t", invalidationLevel: 8.5, whatWouldChangeMyMind: "x", holdingPeriod: "weeks", enteredOn: "2026-08-10",
  };
  saveWldMeta(db, "MECH", {
    schema: "wld-pos-v1", thesis: "t", invalidationLevel: 8.5, conviction: "low", holdingPeriod: "weeks",
    whatWouldChangeMyMind: "x", enteredOn: "2026-08-10", pickRank: 1, entryPrice: 10, peak: 11, atrStop: 9.1, stopFired: event,
  });
  setState(db, "wld:stop_fired:MECH", JSON.stringify(event));
  // price 9 is ABOVE the 7.5 floor — only mechanical mode can sell without a model in the loop.
  const { deps, broker, llm } = mkEveningDeps(db, { prices: { MECH: 9, SPY: 650, IWM: 230, QMOM: 220, NANC: 40 } });
  const res = await runEveningRitual(deps);
  check("ritual ok", res.ok === true, JSON.stringify(res.steps));
  check("mechanical stop fires as placed (sell, no LLM)", broker.submits.some((s) => s.symbol === "MECH" && s.side === "sell") && llm.calls.length === 0);
  const verdict = db.prepare("SELECT class FROM jdg_verdicts WHERE symbol='MECH'").get() as { class: string };
  check("verdict logged as mechanical", verdict?.class === "mechanical");
})();

// ---------- statement + anchor-filing ----------------------------------------------------------

console.log("v2 rituals — statement composes for the right month:");
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-01");
  markEquity(db, "2026-08-05", new Map());
  markEquity(db, "2026-08-28", new Map());
  const cap = capture();
  const res = await runStatementRitual({ db, eff: EFF, mode: "auto", today: "2026-09-01", post: cap.post, latestPrice: async () => null });
  check("statement month = previous month", res.month === "2026-08");
  check("statement posted with the month header", cap.posts.length === 1 && cap.posts[0].includes("monthly statement · 2026-08"));
})();

console.log("v2 rituals — anchor-filing invokes runFilingEvening with injected ports:");
await (async () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  const ancPorts: AnchorPorts = {
    edgar: {
      async filingIndex() { return []; },
      async latest13F(cik: string) { calls.push(cik); return null; },
      async fetchInfoTable() { return ""; },
    },
    mapping: { async tickerForCusip() { return null; } },
    prices: { async latestPrice9() { return null; }, async priceOn9() { return null; } },
  };
  const cap = capture();
  const res = await runAnchorFilingRitual({ db, eff: EFF, mode: "auto", today: "2026-08-20", post: cap.post, latestPrice: async () => null, ancPorts });
  check("period resolved to the just-ended quarter", res.period === latestQuarterEnd("2026-08-20") && res.period === "2026-06-30");
  check("all four managers queried through the injected port", calls.length === 4, String(calls.length));
  check("no filings → no retrade, ritual ok", res.ok === true && res.newFilings === 0 && res.retrade === false, JSON.stringify(res.steps));
  check("late filers noted", cap.posts.some((p) => p.includes("has not filed")));
})();

// ---------- effective-mode double-gate (the v1 rail v2 must honor) ----------
{
  const { effectiveMode } = await import("./mode.js");
  check("MODE=auto without env opt-in degrades to gated", effectiveMode("auto", false) === "gated");
  check("MODE=auto + BILL_ALLOW_AUTO_EXEC=1 → auto", effectiveMode("auto", true) === "auto");
  check("gated stays gated regardless of env", effectiveMode("gated", true) === "gated");
  check("off stays off", effectiveMode("off", false) === "off");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall ritual tests passed");
process.exit(failures ? 1 : 0);
