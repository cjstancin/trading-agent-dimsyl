// Offline tests — v2 Wildcard sleeve: context cards, pool assembly, response validation, the
// code-enforced churn rules, pick sizing, and the ATR stop engine. :memory: SQLite, fixture ports,
// mock broker; no network, no env.
import { openDb, getState } from "./v2/db.js";
import { d9, d9str } from "./v2/decimal.js";
import { seedBook } from "./v2/settled-cash.js";
import { ingestFill } from "./v2/lots.js";
import { loadConfig } from "./v2/config.js";
import type { BrokerPort, BrokerOrderRequest, SubmitResult } from "./v2/broker.js";
import { assemblePool } from "./v2/sleeves/wildcard/pool.js";
import { buildCard, estimateTokens } from "./v2/sleeves/wildcard/card.js";
import { validatePickResponse, sentenceCount } from "./v2/sleeves/wildcard/validate.js";
import { planChurn, weeksBetween } from "./v2/sleeves/wildcard/churn.js";
import { pickCount, perBuyNotional9 } from "./v2/sleeves/wildcard/planner.js";
import { computeAtr, ratchetStep, stopTriggered, morningReplaceStops, emitStopFired } from "./v2/sleeves/wildcard/stops.js";
import { runWeeklyPicks } from "./v2/sleeves/wildcard/run.js";
import {
  ensureWildcardTables, saveMeta, loadMeta, heldPositions, logBookEvent,
} from "./v2/sleeves/wildcard/store.js";
import {
  fixturePoolPort, fixtureCardPort, fixturePickPort, fixtureBars, validPick,
} from "./v2/sleeves/wildcard/fixtures.js";
import { siblingPoolPort } from "./v2/sleeves/wildcard/adapters.js";
import type { PoolEntry, WldPosMeta } from "./v2/sleeves/wildcard/types.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

function mockBroker(): BrokerPort & { submits: BrokerOrderRequest[] } {
  const submits: BrokerOrderRequest[] = [];
  return {
    submits,
    async submit(req): Promise<SubmitResult> {
      submits.push(req);
      return { outcome: "accepted", order: { id: `oid-${submits.length}`, status: "accepted" } };
    },
    async queryByClientOrderId() { return null; },
    async getOpenOrders() { return []; },
    async cancelOrder() { return true; },
  };
}

const CFG = loadConfig().config;   // committed defaults; tests read the same dials the sleeve does
const CV = "v2c-test+0";
const WCFG = {
  minHoldWeeks: Number(CFG.wildcard.minHoldWeeks),
  reentryCooldownWeeks: Number(CFG.wildcard.reentryCooldownWeeks),
  maxChangesPerWeek: Number(CFG.wildcard.maxChangesPerWeek),
};
const poolEntry = (symbol: string, over: Partial<PoolEntry> = {}): PoolEntry =>
  ({ symbol, momentumRank: null, insiderCluster: null, anchorManagers: [], ...over });
const posMeta = (over: Partial<WldPosMeta> = {}): WldPosMeta => ({
  schema: "wld-pos-v1", thesis: "Original thesis. Still standing.", invalidationLevel: 80,
  conviction: "high", holdingPeriod: "months", whatWouldChangeMyMind: "A guidance cut.",
  enteredOn: "2026-07-01", pickRank: 1, entryPrice: 100, peak: 100, atrStop: null, ...over,
});

console.log("v2 wildcard:");

// ---------- pool assembly: dedupe + merged flags ----------
await (async () => {
  const pool = await assemblePool(fixturePoolPort());
  const syms = pool.map((p) => p.symbol);
  check("pool deduped (25 mom + 2 ins + 3 anc, 2 overlaps → 28)", pool.length === 28, String(pool.length));
  check("no duplicate symbols", new Set(syms).size === syms.length);
  const aapl = pool.find((p) => p.symbol === "AAPL")!;
  check("overlap merges mom rank + anchor managers", aapl.momentumRank === 1 && aapl.anchorManagers.includes("Berkshire Hathaway"));
  const insa = pool.find((p) => p.symbol === "INSA")!;
  check("overlap merges mom rank + live insider flag", insa.momentumRank === 4 && insa.insiderCluster === "live");
  const shdw = pool.find((p) => p.symbol === "SHDW")!;
  check("shadow-book signal pool-eligible + flagged shadow", shdw.insiderCluster === "shadow");
  check("deterministic order: momentum ranks first", syms[0] === "AAPL" && syms[1] === "MSFT");
})();

// ---------- context card builder ----------
await (async () => {
  const cardPort = fixtureCardPort();
  const entry = poolEntry("AAPL", { momentumRank: 1, insiderCluster: "live", anchorManagers: ["Berkshire Hathaway"] });
  const built = buildCard({
    entry,
    fundamentals: await cardPort.fundamentals("AAPL"),
    news: await cardPort.newsClaims("AAPL"),
    pricePath: await cardPort.pricePath("AAPL"),
    leiStage: "engage", asOf: "2026-08-17",
  }, Number(CFG.wildcard.contextCardMaxTokens));

  const c = built.card;
  check("schema fields present", c.schema === "wld-card-v1" && c.ticker === "AAPL" && c.asOf === "2026-08-17"
    && c.pricePath !== null && c.fundamentals !== null && Array.isArray(c.news));
  check("insider/13F flags + LEI stage on card", c.flags.insiderCluster === "live"
    && c.flags.anchorManagers.includes("Berkshire Hathaway") && c.flags.momentumRank === 1 && c.leiStage === "engage");
  check("every claim dated YYYY-MM-DD", c.news.length === 5 && c.news.every((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.date)));
  check("claims newest-first", c.news[0].date === "2026-08-12" && c.news[4].date === "2026-07-01");
  check("~10-field fundamentals snapshot dated", Object.keys(c.fundamentals!.fields).length === 10 && c.fundamentals!.asOf === "2026-08-14");
  check("within budget, nothing dropped", built.tokens <= Number(CFG.wildcard.contextCardMaxTokens) && built.dropped.length === 0);

  // Force truncation with bloated claims + a tiny budget: whole claims drop (extractive), never partial.
  const fat = fixtureCardPort({ claimChars: 700 });
  const fatNews = await fat.newsClaims("AAPL");
  const tight = buildCard({
    entry, fundamentals: await fat.fundamentals("AAPL"), news: fatNews,
    pricePath: await fat.pricePath("AAPL"), leiStage: "engage", asOf: "2026-08-17",
  }, 400);
  check("token budget enforced", tight.tokens <= 400, String(tight.tokens));
  check("truncation dropped something, audited", tight.dropped.length > 0);
  const originals = new Map(fatNews.map((n) => [n.date, n.claim.trim()]));
  check("surviving claims intact (never mid-claim)", tight.card.news.every((n) => originals.get(n.date) === n.claim));
  check("oldest claims dropped first", tight.card.news.every((n, i, a) => i === 0 || a[i - 1].date >= n.date)
    && (tight.card.news.length === 0 || tight.card.news[0].date === "2026-08-12"));

  // Invalid claim shapes (missing date/source — the raw-text smuggling vector) are dropped.
  const dirty = buildCard({
    entry, fundamentals: null,
    news: [{ date: "not-a-date", source: "x", tickers: [], claim: "undated prose blob" } as any,
           { date: "2026-08-01", source: "", tickers: [], claim: "sourceless" } as any,
           { date: "2026-08-02", source: "edgar", tickers: ["AAPL"], claim: "valid claim", number: 1 }],
    pricePath: null, leiStage: "engage", asOf: "2026-08-17",
  }, 2500);
  check("malformed claims dropped, valid kept", dirty.card.news.length === 1 && dirty.card.news[0].claim === "valid claim");
  check("estimateTokens ≈ chars/4", estimateTokens("x".repeat(400)) === Math.ceil(402 / 4));
})();

// ---------- response validation ----------
{
  const pool = new Set(["AAPL", "MSFT", "NVDA", "OXY"]);
  const ok = validatePickResponse([validPick("AAPL", 1), validPick("MSFT", 2)], pool);
  check("valid response passes, rank-sorted", ok.ok && ok.picks.length === 2 && ok.picks[0].ticker === "AAPL");

  const oop = validatePickResponse([validPick("AAPL", 1), validPick("TSLA", 2)], pool);
  check("out-of-pool ticker rejects WHOLE response", !oop.ok && /TSLA/.test((oop as any).reason));

  const noInv = validatePickResponse([validPick("AAPL", 1, { invalidation_level: undefined })], pool);
  check("missing invalidation rejected", !noInv.ok && /invalidation/.test((noInv as any).reason));
  const zeroInv = validatePickResponse([validPick("AAPL", 1, { invalidation_level: 0 })], pool);
  check("non-positive invalidation rejected", !zeroInv.ok);

  const longThesis = validatePickResponse([validPick("AAPL", 1, {
    thesis: "One sentence. Two sentences here. Three is the limit. Four breaks the schema.",
  })], pool);
  check("4-sentence thesis rejected", !longThesis.ok && /sentences/.test((longThesis as any).reason));
  check("sentence counter", sentenceCount("A. B! C?") === 3 && sentenceCount("One only") === 1);

  check("malformed JSON string rejected", !validatePickResponse("{nope[", pool).ok);
  check("valid JSON string accepted", validatePickResponse(JSON.stringify([validPick("OXY", 1)]), pool).ok);
  check("empty array rejected", !validatePickResponse([], pool).ok);
  check("duplicate ticker rejected", !validatePickResponse([validPick("AAPL", 1), validPick("AAPL", 2)], pool).ok);
  check("bad conviction bucket rejected", !validatePickResponse([validPick("AAPL", 1, { conviction_bucket: "yolo" })], pool).ok);
  check("bad holding period rejected", !validatePickResponse([validPick("AAPL", 1, { holding_period: "forever" })], pool).ok);
  check("missing what_would_change_my_mind rejected", !validatePickResponse([validPick("AAPL", 1, { what_would_change_my_mind: " " })], pool).ok);
}

// ---------- churn engine ----------
{
  check("weeksBetween", weeksBetween("2026-07-01", "2026-07-22") === 3 && weeksBetween("2026-07-01", "2026-08-05") === 5);
  const vp = (t: string, r: number) => validatePickResponse([validPick(t, r)], new Set([t])) as any;
  const pick = (t: string, r: number) => (vp(t, r).picks[0]);

  // Min-hold blocks a swap at week 3 (no breach).
  const wk3 = planChurn({
    asOfDate: "2026-07-22",
    held: [{ symbol: "OLD1", enteredOn: "2026-07-01", invalidationLevel: 80, latestPrice: 95 }],
    picks: [pick("NEW1", 1)], recentSells: [], targetCount: 1, cfg: WCFG,
  });
  check("min-hold blocks swap at week 3", wk3.sells.length === 0 && wk3.buys.length === 0
    && wk3.blocked.some((b) => b.symbol === "NEW1" && /min-hold/.test(b.why)));

  // Week 5 + invalidation breach → forced exit + refill.
  const wk5 = planChurn({
    asOfDate: "2026-08-05",
    held: [{ symbol: "OLD1", enteredOn: "2026-07-01", invalidationLevel: 80, latestPrice: 79 }],
    picks: [pick("NEW1", 1)], recentSells: [], targetCount: 1, cfg: WCFG,
  });
  check("invalidation breach sells at week 5 + refills", wk5.sells.length === 1
    && wk5.sells[0].reason === "invalidation_breach" && wk5.buys.length === 1 && wk5.buys[0].pick.ticker === "NEW1");

  // Breach overrides min-hold entirely (week 2).
  const wk2 = planChurn({
    asOfDate: "2026-07-15",
    held: [{ symbol: "OLD1", enteredOn: "2026-07-01", invalidationLevel: 80, latestPrice: 80 }],
    picks: [], recentSells: [], targetCount: 1, cfg: WCFG,
  });
  check("breach overrides min-hold (week 2, price AT level)", wk2.sells.length === 1 && wk2.sells[0].reason === "invalidation_breach");

  // Cooldown blocks re-entry at week 3, allows the next-ranked name instead.
  const cd = planChurn({
    asOfDate: "2026-07-22",
    held: [], picks: [pick("SOLD", 1), pick("FRESH", 2)],
    recentSells: [{ symbol: "SOLD", exitedOn: "2026-07-01" }], targetCount: 1, cfg: WCFG,
  });
  check("cooldown blocks re-entry at week 3", cd.buys.length === 1 && cd.buys[0].pick.ticker === "FRESH"
    && cd.blocked.some((b) => b.symbol === "SOLD" && /cooldown/.test(b.why)));
  const cd5 = planChurn({
    asOfDate: "2026-08-05",
    held: [], picks: [pick("SOLD", 1)],
    recentSells: [{ symbol: "SOLD", exitedOn: "2026-07-01" }], targetCount: 1, cfg: WCFG,
  });
  check("cooldown expires (week 5 re-entry ok)", cd5.buys.length === 1 && cd5.buys[0].pick.ticker === "SOLD");

  // Max-1-change: model demands 3 swaps into a full, healthy, past-min-hold book → exactly ONE
  // (the highest-ranked) executes; displaced survivor = smallest headroom above invalidation.
  const swaps = planChurn({
    asOfDate: "2026-08-19",
    held: [
      { symbol: "OLDA", enteredOn: "2026-06-01", invalidationLevel: 80, latestPrice: 120 },  // 33% headroom
      { symbol: "OLDB", enteredOn: "2026-06-01", invalidationLevel: 80, latestPrice: 88 },   // 9% headroom → weakest
      { symbol: "OLDC", enteredOn: "2026-06-01", invalidationLevel: 80, latestPrice: 100 },  // 20% headroom
    ],
    picks: [pick("NEWA", 1), pick("NEWB", 2), pick("NEWC", 3)],
    recentSells: [], targetCount: 3, cfg: WCFG,
  });
  check("3-swap demand clips to the single top-ranked change",
    swaps.sells.length === 1 && swaps.buys.length === 1 && swaps.buys[0].pick.ticker === "NEWA" && swaps.buys[0].slot === "swap");
  check("weakest-headroom survivor displaced", swaps.sells[0].symbol === "OLDB" && swaps.sells[0].reason === "swap");
  check("refused demands audited", swaps.blocked.filter((b) => /max changes/.test(b.why)).length === 2);

  // Held name NOT re-litigated: absent from picks ≠ sell. Healthy held book + no overlapping picks
  // and a full book → only the budgeted single swap, never a liquidation of unmentioned names.
  const unre = planChurn({
    asOfDate: "2026-08-19",
    held: [
      { symbol: "OLDA", enteredOn: "2026-06-01", invalidationLevel: 80, latestPrice: 120 },
      { symbol: "OLDB", enteredOn: "2026-06-01", invalidationLevel: 80, latestPrice: 110 },
    ],
    picks: [pick("NEWA", 1)], recentSells: [], targetCount: 2, cfg: WCFG,
  });
  check("held names not re-litigated (one swap max, stronger hold survives untouched)",
    unre.sells.length === 1 && unre.sells[0].symbol === "OLDB"
    && unre.buys.length === 1 && unre.buys[0].pick.ticker === "NEWA");

  // Bootstrap: empty book fills ALL open slots (slot-fills are not budget-capped).
  const boot = planChurn({
    asOfDate: "2026-08-19", held: [],
    picks: [pick("NEWA", 1), pick("NEWB", 2), pick("NEWC", 3)],
    recentSells: [], targetCount: 2, cfg: WCFG,
  });
  check("bootstrap fills both slots best-rank-first", boot.buys.length === 2
    && boot.buys[0].pick.ticker === "NEWA" && boot.buys[1].pick.ticker === "NEWB" && boot.buys.every((b) => b.slot === "fill"));

  // Unknown price → NOT a breach (fail-safe hold).
  const nopx = planChurn({
    asOfDate: "2026-08-19",
    held: [{ symbol: "OLDA", enteredOn: "2026-06-01", invalidationLevel: 80, latestPrice: null }],
    picks: [], recentSells: [], targetCount: 1, cfg: WCFG,
  });
  check("unknown price never triggers a breach sell", nopx.sells.length === 0);
}

// ---------- pick count + sizing ----------
{
  check("2 picks at $500 sleeve", pickCount(CFG, 500) === 2);
  check("count scales at larger sleeve (capped at countMax)", pickCount(CFG, 1000) === Number(CFG.wildcard.picks.countMax)
    && pickCount(CFG, 100000) === Number(CFG.wildcard.picks.countMax));
  check("count floor at tiny sleeve", pickCount(CFG, 120) === Number(CFG.wildcard.picks.count));

  check("$500 / 2 picks ≈ $250 each", d9str(perBuyNotional9(d9("500"), 2, 1.0)) === "250");
  check("deployScalar 0.55 scales sizing", d9str(perBuyNotional9(d9("500"), 2, 0.55)) === "137.5");
  check("deployScalar 0.7 scales sizing", d9str(perBuyNotional9(d9("500"), 3, 0.7)) === "116.666666667");
  let threw = false;
  try { perBuyNotional9(d9("500"), 2, 1.5); } catch { threw = true; }
  check("deployScalar > 1 refused", threw);
}

// ---------- ATR math + ratchet ----------
{
  // Constant-range, zero-drift bars: every TR = 2 → ATR(14) = 2 exactly.
  const flat = fixtureBars(20, { close: 100, range: 2 });
  check("ATR from constant-range fixture bars = range", computeAtr(flat, 14) === 2);
  check("ATR needs days+1 bars", computeAtr(fixtureBars(14), 14) === null && computeAtr(fixtureBars(15), 14) !== null);
  // Rising closes with drift ≤ range/2 keep TR = range (gap absorbed by the bar range).
  const rising = fixtureBars(20, { close: 100, range: 2, driftPerBar: 1 });
  check("ATR stable under drift within range", computeAtr(rising, 14) === 2);

  // Ratchet: multiple from config (2.5) × ATR 2 = 5 below peak.
  const mult = Number(CFG.wildcard.atrStop.multiple);
  let r = ratchetStep({ peak: 100, atrStop: null }, 100, 2, mult);
  check("initial stop = peak − 2.5×ATR", r.peak === 100 && r.atrStop === 95);
  r = ratchetStep(r, 110, 2, mult);
  check("peak ratchets up, stop follows", r.peak === 110 && r.atrStop === 105);
  r = ratchetStep(r, 98, 2, mult);
  check("price drop never lowers stop (monotone)", r.peak === 110 && r.atrStop === 105);
  r = ratchetStep(r, 98, 4, mult);       // ATR expansion would imply a LOWER stop → ratchet holds
  check("ATR expansion never lowers stop", r.atrStop === 105);
  check("stopTriggered at/below level", stopTriggered(posMeta({ atrStop: 105 }), 105) === true
    && stopTriggered(posMeta({ atrStop: 105 }), 105.01) === false
    && stopTriggered(posMeta({ atrStop: null }), 1) === false);
}

// ---------- morning re-place: day-TIF broker stops through the gateway ----------
await (async () => {
  const db = openDb(":memory:");
  ensureWildcardTables(db);
  seedBook(db, "5000", "2026-08-17");
  ingestFill(db, { id: "wf1", symbol: "AAPL", side: "buy", qty9: d9("2.5"), price9: d9("100"), ts: "2026-08-10T15:00:00Z", sleeve: "wld" });
  saveMeta(db, "AAPL", posMeta({ enteredOn: "2026-08-10", entryPrice: 100, peak: 100, atrStop: null }));

  const b = mockBroker();
  const deps = { bars: async () => fixtureBars(20, { close: 100, range: 2 }), latest: async () => 110 };
  const opts = { asOfDate: "2026-08-17", configVersion: CV, atrDays: Number(CFG.wildcard.atrStop.atrDays),
    multiple: Number(CFG.wildcard.atrStop.multiple), washBlacklistDays: Number(CFG.ledger.washBlacklistDays) };
  const res1 = await morningReplaceStops(db, b, deps, opts);
  check("stop placed for held position", res1.placed.length === 1 && res1.placed[0].symbol === "AAPL");
  const wire = b.submits[0];
  check("broker stop order is stop/day-TIF sell", wire.type === "stop" && wire.time_in_force === "day"
    && wire.side === "sell" && wire.symbol === "AAPL");
  check("stop at ratchet level (peak 110 − 2.5×2 = 105)", wire.stop_price === "105" && wire.qty === "2.5");
  check("coid owned by wld + intent stop", (wire.client_order_id ?? "").startsWith("wld:AAPL:stop:"));
  const meta1 = loadMeta(db, "AAPL")!;
  check("meta ratchet persisted", meta1.peak === 110 && meta1.atrStop === 105);

  // Next morning, price fell: peak holds, stop NEVER re-places lower.
  const res2 = await morningReplaceStops(db, b, { ...deps, latest: async () => 98 }, { ...opts, asOfDate: "2026-08-18" });
  check("re-place next day emits fresh day-TIF order", res2.placed.length === 1 && b.submits.length === 2);
  check("stop not lowered on drawdown", b.submits[1].stop_price === "105");

  // Wash-blacklist exemption: a recent realized-loss exit must NOT block the protective stop.
  ingestFill(db, { id: "wf2", symbol: "LOSS", side: "buy", qty9: d9("1"), price9: d9("100"), ts: "2026-08-03T15:00:00Z", sleeve: "wld" });
  ingestFill(db, { id: "wf3", symbol: "LOSS", side: "sell", qty9: d9("1"), price9: d9("90"), ts: "2026-08-12T15:00:00Z", sleeve: "wld" });
  ingestFill(db, { id: "wf4", symbol: "LOSS", side: "buy", qty9: d9("1"), price9: d9("95"), ts: "2026-08-14T15:00:00Z", sleeve: "wld" });
  saveMeta(db, "LOSS", posMeta({ enteredOn: "2026-08-14", entryPrice: 95, peak: 95 }));
  const res3 = await morningReplaceStops(db, b, deps, { ...opts, asOfDate: "2026-08-19" });
  check("stop placement blacklist-exempt after loss exit", res3.placed.some((p) => p.symbol === "LOSS"), JSON.stringify(res3.skipped));

  // stop_fired: handoff carries ORIGINAL thesis + invalidation; position freezes.
  const ev = emitStopFired(db, "AAPL", { firedPrice9: d9("104.9"), ts: "2026-08-19T14:31:00Z", source: "broker_fill" })!;
  check("stop_fired event carries thesis + invalidation", ev.schema === "wld-stop-fired-v1"
    && ev.thesis === "Original thesis. Still standing." && ev.invalidationLevel === 80
    && ev.whatWouldChangeMyMind === "A guidance cut." && ev.firedPrice === "104.9" && ev.entryPrice === 100);
  const stateEv = JSON.parse(getState(db, "wld:stop_fired:AAPL")!);
  check("handoff written to state key wld:stop_fired:AAPL", stateEv.symbol === "AAPL" && stateEv.invalidationLevel === 80);
  check("fired position frozen (excluded from active)", heldPositions(db, true).every((h) => h.symbol !== "AAPL"));
  const again = emitStopFired(db, "AAPL", { firedPrice9: d9("50"), ts: "2026-08-20T14:00:00Z", source: "bot_ratchet" })!;
  check("re-fire idempotent (original event kept)", again.firedPrice === "104.9");
  const res4 = await morningReplaceStops(db, b, deps, { ...opts, asOfDate: "2026-08-20" });
  check("no stop re-armed while thesis-check pending", res4.placed.every((p) => p.symbol !== "AAPL"));
  check("unknown symbol → null (nothing to hand over)", emitStopFired(db, "GHOST", { firedPrice9: d9("1"), ts: "2026-08-20T14:00:00Z", source: "bot_ratchet" }) === null);
})();

// ---------- weekly run: bootstrap end-to-end (fixture ports, mock broker) ----------
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  const b = mockBroker();
  const pickPort = fixturePickPort([[validPick("NVDA", 1), validPick("OXY", 2), validPick("GOOGL", 3)]]);
  const res = await runWeeklyPicks(db, b, { pool: fixturePoolPort(), card: fixtureCardPort(), pick: pickPort }, {
    asOfDate: "2026-08-17", leiStage: "engage", deployScalar: 1.0, sleeveEquity9: d9("500"),
    configVersion: CV, cfg: CFG, latestPrice: async () => 100,
  });
  check("bootstrap applied: 2 buys (targetCount at $500)", res.action === "applied"
    && res.orders.filter((o) => o.side === "buy" && o.placed).length === 2, JSON.stringify(res.orders));
  check("buys are top-2 ranked picks", res.orders[0].symbol === "NVDA" && res.orders[1].symbol === "OXY");
  check("equal-sized $250 notional buys", b.submits.every((s) => s.notional === "250" && s.side === "buy" && s.type === "market"));
  check("cards sent for full pool (28 names, none held)", res.cardsSent === 28);
  const meta = loadMeta(db, "NVDA")!;
  check("position_meta carries thesis/invalidation/entry/peak/atrStop", meta.invalidationLevel === 80
    && meta.thesis.length > 0 && meta.entryPrice === 100 && meta.peak === 100 && meta.atrStop === null && meta.pickRank === 1);
  const audit = db.prepare("SELECT valid, config_version FROM wld_picks").all() as any[];
  check("audit row written, valid, config-stamped", audit.length === 1 && audit[0].valid === 1 && audit[0].config_version === CV);
  check("same-week re-run is a noop", (await runWeeklyPicks(db, b, {
    pool: fixturePoolPort(), card: fixtureCardPort(), pick: fixturePickPort([]),
  }, { asOfDate: "2026-08-19", leiStage: "engage", sleeveEquity9: d9("500"), configVersion: CV, cfg: CFG, latestPrice: async () => 100 })).action === "noop");
})();

// ---------- weekly run: malformed response → keep last book ----------
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  // Existing holding that a malformed week must NOT disturb.
  ensureWildcardTables(db);
  ingestFill(db, { id: "kf1", symbol: "KEEP", side: "buy", qty9: d9("2"), price9: d9("100"), ts: "2026-08-03T15:00:00Z", sleeve: "wld" });
  saveMeta(db, "KEEP", posMeta({ enteredOn: "2026-08-03" }));
  logBookEvent(db, "KEEP", "enter", "2026-08-03", "seed");

  const b = mockBroker();
  const res = await runWeeklyPicks(db, b, {
    pool: fixturePoolPort(), card: fixtureCardPort(), pick: fixturePickPort(["{malformed json["]),
  }, { asOfDate: "2026-08-17", leiStage: "caution", sleeveEquity9: d9("500"), configVersion: CV, cfg: CFG, latestPrice: async () => 100 });
  check("malformed JSON → kept_last_book, zero orders", res.action === "kept_last_book" && b.submits.length === 0);
  check("holding untouched", loadMeta(db, "KEEP") !== null && !loadMeta(db, "KEEP")!.pendingExit);
  const audit = db.prepare("SELECT valid, reject_reason FROM wld_picks").get() as any;
  check("rejection audited (valid=0 + reason)", audit.valid === 0 && /malformed/i.test(audit.reject_reason));

  // Held names are excluded from the model's pool ("not re-litigated"): next week, KEEP not in cards.
  const pickPort = fixturePickPort([[validPick("NVDA", 1)]]);
  await runWeeklyPicks(db, b, { pool: fixturePoolPort({ mom: [{ symbol: "KEEP", rank: 1 }, { symbol: "NVDA", rank: 2 }] }), card: fixtureCardPort(), pick: pickPort },
    { asOfDate: "2026-08-24", leiStage: "engage", sleeveEquity9: d9("500"), configVersion: CV, cfg: CFG, latestPrice: async () => 100 });
  check("held name excluded from cards sent to model", pickPort.seen.length === 1
    && pickPort.seen[0].every((c) => c.ticker !== "KEEP") && pickPort.seen[0].some((c) => c.ticker === "NVDA"));
})();

// ---------- weekly run: deployScalar scales live sizing ----------
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  const b = mockBroker();
  await runWeeklyPicks(db, b, {
    pool: fixturePoolPort(), card: fixtureCardPort(),
    pick: fixturePickPort([[validPick("NVDA", 1), validPick("OXY", 2)]]),
  }, { asOfDate: "2026-08-17", leiStage: "pullback", deployScalar: 0.55, sleeveEquity9: d9("500"),
    configVersion: CV, cfg: CFG, latestPrice: async () => 100 });
  check("pullback dial (0.55) scales buys to $137.50", b.submits.length === 2 && b.submits.every((s) => s.notional === "137.5"),
    JSON.stringify(b.submits.map((s) => s.notional)));
})();

// ---------- sibling pool adapter: best-effort reads, missing tables = empty ----------
await (async () => {
  const db = openDb(":memory:");
  const empty = siblingPoolPort(db);
  check("missing sibling tables → empty pool sources",
    (await empty.momentumTop(25)).length === 0 && (await empty.insiderLiveClusters()).length === 0 && (await empty.anchorTop5s()).length === 0);

  // Tables present (assumed shapes) → rows flow through.
  db.exec(`CREATE TABLE mom_ranks (symbol TEXT, rank INTEGER);
           CREATE TABLE ins_clusters (symbol TEXT, cluster_id INTEGER);
           CREATE TABLE anc_clone (symbol TEXT, manager TEXT);`);
  db.prepare("INSERT INTO mom_ranks VALUES('nvda', 2), ('AAPL', 1), ('AAPL', 3)").run();
  db.prepare("INSERT INTO ins_clusters VALUES('CASY', 7), ('CASY', 8)").run();
  db.prepare("INSERT INTO anc_clone VALUES('OXY','Berkshire Hathaway'), ('OXY','Himalaya Capital'), ('GOOGL','TCI Fund Management')").run();
  const port = siblingPoolPort(db);
  const mom = await port.momentumTop(25);
  check("mom_ranks read, upcased, best-rank deduped", mom.length === 2 && mom[0].symbol === "AAPL" && mom[0].rank === 1 && mom[1].symbol === "NVDA");
  const ins = await port.insiderLiveClusters();
  check("ins_clusters read distinct", ins.length === 1 && ins[0].symbol === "CASY" && ins[0].live === true);
  const anc = await port.anchorTop5s();
  check("anc_clone grouped by symbol w/ managers", anc.length === 2
    && anc.find((a) => a.symbol === "OXY")!.managers.length === 2);
})();

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("v2 wildcard: all green");
