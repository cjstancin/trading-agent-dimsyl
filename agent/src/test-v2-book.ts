// Offline tests — v2 book layer: LEI dial, graduated brake, SGOV sweep, equity marks + day-trade
// guard, dial trims, benchmarks + gate progress. :memory: DB + mock broker; no network, no env.
import { openDb, getState, setState } from "./v2/db.js";
import { d9, d9str } from "./v2/decimal.js";
import { seedBook, recordCash } from "./v2/settled-cash.js";
import { ingestFill } from "./v2/lots.js";
import { placeOrder } from "./v2/order-gateway.js";
import type { BrokerPort, BrokerOrderRequest, SubmitResult } from "./v2/broker.js";
import { decideDial, resolveDial, scalarFor, spyAbove200, type DialConfig } from "./v2/book/lei-dial.js";
import { decideTier, updateBrake, tier3Plan, type BrakeConfig } from "./v2/book/brake.js";
import { decideSweep, runSweep } from "./v2/book/sweep.js";
import { markEquity, equityCurve, realizedMaxDrawdownPct, dayTradeCount, wouldCompleteRoundTrip, dayTradeGuard } from "./v2/book/equity.js";
import { planDialTrims, executeTrims, sleeveValue9 } from "./v2/book/trims.js";
import { recordBench, benchSeries, totalReturn, gateProgress, wildcardRivalBasket } from "./v2/book/benchmarks.js";

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

const DIAL_CFG: DialConfig = {
  stages: { engage: 1.0, caution: 0.7, pullback: 0.55 },
  appliesTo: ["mom", "wld"],
  staleAfterDays: 14,
  stageMap: { engage: "engage", caution: "caution", pullback: "pullback" },
};
const BRAKE_CFG: BrakeConfig = { tiers: [{ ddPct: 8, action: "" }, { ddPct: 11, action: "" }, { ddPct: 14, action: "" }], hysteresisPct: 2 };

console.log("v2 book — LEI dial:");
{
  const fresh = decideDial({ cfg: DIAL_CFG, reading: { stage: "caution", asOf: "2026-08-10" }, lastKnown: null, today: "2026-08-17", spyAbove200dma: true });
  check("fresh reading maps", fresh.position === "caution" && fresh.scalar === 0.7 && fresh.source === "lei");
  const unmapped = decideDial({ cfg: DIAL_CFG, reading: { stage: "NEUTRAL-45", asOf: "2026-08-16" }, lastKnown: { position: "engage", asOf: "2026-08-10" }, today: "2026-08-17", spyAbove200dma: false });
  check("unmapped stage → last-known", unmapped.position === "engage" && unmapped.source === "last-known" && unmapped.flags.some((f) => f.includes("unmapped")));
  const stale = decideDial({ cfg: DIAL_CFG, reading: { stage: "engage", asOf: "2026-07-01" }, lastKnown: { position: "caution", asOf: "2026-07-01" }, today: "2026-08-17", spyAbove200dma: true });
  check("stale + stale last-known → SPY fallback engage", stale.position === "engage" && stale.source === "spy-200dma-fallback");
  const dark = decideDial({ cfg: DIAL_CFG, reading: null, lastKnown: null, today: "2026-08-17", spyAbove200dma: null });
  check("everything dark → conservative pullback", dark.position === "pullback" && dark.scalar === 0.55);
  check("dial exempts contrarian sleeves", scalarFor("ins", fresh, DIAL_CFG) === 1.0 && scalarFor("anc", fresh, DIAL_CFG) === 1.0);
  check("dial applies to mom+wld", scalarFor("mom", fresh, DIAL_CFG) === 0.7 && scalarFor("wld", fresh, DIAL_CFG) === 0.7);

  const db = openDb(":memory:");
  const r1 = resolveDial(db, { cfg: DIAL_CFG, reading: { stage: "engage", asOf: "2026-08-17" }, today: "2026-08-17", spyAbove200dma: true });
  check("first resolve: no change flag", r1.changed === false);
  const r2 = resolveDial(db, { cfg: DIAL_CFG, reading: { stage: "pullback", asOf: "2026-08-18" }, today: "2026-08-18", spyAbove200dma: true });
  check("downgrade detected", r2.changed === true && r2.previous === "engage" && r2.position === "pullback");

  const closes = Array.from({ length: 220 }, (_, i) => 100 + i * 0.1);
  check("spyAbove200 rising tape", spyAbove200(closes) === true);
  check("spyAbove200 needs 200 rows", spyAbove200([1, 2, 3]) === null);
}

console.log("v2 book — brake:");
{
  check("tier entry at 8", decideTier(0, 8.0, BRAKE_CFG) === 1);
  check("tier entry at 11", decideTier(0, 11.2, BRAKE_CFG) === 2);
  check("tier entry at 14", decideTier(1, 14.0, BRAKE_CFG) === 3);
  check("deeper immediately", decideTier(1, 12.0, BRAKE_CFG) === 2);
  check("hysteresis holds tier", decideTier(1, 7.0, BRAKE_CFG) === 1);      // needs ≤6 to re-arm
  check("hysteresis re-arms", decideTier(1, 5.9, BRAKE_CFG) === 0);
  check("re-arm steps through tiers", decideTier(3, 8.5, BRAKE_CFG) === 1); // ≤12 clears t3, ≤9 clears t2, 8.5>6 keeps t1

  const db = openDb(":memory:");
  const s1 = updateBrake(db, d9("5000"), BRAKE_CFG);
  check("peak seeds", s1.tier === 0 && s1.peak9 === "5000" && s1.sizeFactor === 1.0);
  const s2 = updateBrake(db, d9("4550"), BRAKE_CFG); // −9%
  check("tier1 halves buys", s2.tier === 1 && s2.sizeFactor === 0.5 && s2.newBuysAllowed);
  const s3 = updateBrake(db, d9("4250"), BRAKE_CFG); // −15%
  check("tier3 escalates once", s3.tier === 3 && s3.escalate === true && !s3.newBuysAllowed);
  const s4 = updateBrake(db, d9("4250"), BRAKE_CFG);
  check("no re-escalation while in tier3", s4.escalate === false);
  const s5 = updateBrake(db, d9("5100"), BRAKE_CFG);
  check("recovery re-arms + new peak", s5.tier === 0 && s5.peak9 === "5100");

  const plan = tier3Plan([
    { sleeve: "ins", symbol: "AAA", price: 8, floor: 10 },
    { sleeve: "wld", symbol: "BBB", price: 50, floor: 40 },
    { sleeve: "mom", symbol: "CCC", price: 20 },
  ]);
  check("tier3 plan: below-floor auto-sells", plan.autoSell.length === 1 && plan.autoSell[0].symbol === "AAA");
  check("tier3 plan: rest needs CJ's call", plan.needsCall.length === 2);
}

console.log("v2 book — SGOV sweep:");
{
  const idle = decideSweep({ settled9: d9("800"), float9: d9("50"), need9: 0n, sgovQty9: 0n, sgovPrice9: d9("100.5") });
  check("idle cash sweeps in above float", idle.action === "buy" && d9str(idle.notional9!) === "750");
  const within = decideSweep({ settled9: d9("49"), float9: d9("50"), need9: 0n, sgovQty9: 0n, sgovPrice9: d9("100.5") });
  check("within float: no sweep", within.action === "none");
  const short = decideSweep({ settled9: d9("100"), float9: d9("50"), need9: d9("300"), sgovQty9: d9("10"), sgovPrice9: d9("100") });
  check("shortfall liquidates SGOV first", short.action === "sell" && d9str(short.qty9!) === "2");
  const capped = decideSweep({ settled9: d9("0"), float9: d9("50"), need9: d9("5000"), sgovQty9: d9("3"), sgovPrice9: d9("100") });
  check("liquidation capped at held qty", capped.action === "sell" && d9str(capped.qty9!) === "3");

  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  const broker = mockBroker();
  const run = await runSweep(db, broker, { cfg: { etf: "SGOV", floatUsd: 50 }, asOfDate: "2026-08-17", configVersion: "t", sgovPrice9: d9("100.5"), washBlacklistDays: 31 });
  check("sweep buy placed via gateway", run.result?.placed === true && broker.submits[0].symbol === "SGOV" && broker.submits[0].notional === "4950");
  check("sweep coid owned by book", run.result?.clientOrderId === "book:SGOV:sweep:20260817:01");
}

console.log("v2 book — equity marks + day-trade guard:");
{
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  ingestFill(db, { id: "e1", symbol: "AAPL", side: "buy", qty9: d9("10"), price9: d9("200"), ts: "2026-08-17T14:31:00Z", sleeve: "mom" });
  recordCash(db, { ts: "2026-08-17T14:31:00Z", kind: "buy", symbol: "AAPL", amount9: -d9("2000"), settlesOn: "2026-08-17", ref: "e1" });
  const m1 = markEquity(db, "2026-08-17", new Map([["AAPL", d9("210")]]), { dial: "engage", brakeTier: 0 });
  check("equity = cash + positions", d9str(m1.equity9) === "5100" && d9str(m1.cash9) === "3000");
  const m2 = markEquity(db, "2026-08-18", new Map(), {});
  check("missing price falls back to prior mark + flagged", d9str(m2.equity9) === "5100" && m2.missingPrices.includes("AAPL"));
  markEquity(db, "2026-08-19", new Map([["AAPL", d9("150")]]), {});
  check("curve ascending", equityCurve(db).map((r) => r.date).join(",") === "2026-08-17,2026-08-18,2026-08-19");
  const dd = realizedMaxDrawdownPct(db);
  check("realized max DD from curve", Math.abs(dd - 11.76) < 0.01, String(dd)); // 5100→4500

  // Day-trade guard: same-day round trip counting + gateway refusal at the max.
  ingestFill(db, { id: "e2", symbol: "AAPL", side: "sell", qty9: d9("10"), price9: d9("210"), ts: "2026-08-17T15:00:00Z", sleeve: "mom" });
  check("round trip counted", dayTradeCount(db, "2026-08-17") === 1);
  ingestFill(db, { id: "e3", symbol: "TSLA", side: "buy", qty9: d9("1"), price9: d9("100"), ts: "2026-08-18T14:00:00Z", sleeve: "wld" });
  check("open leg detected", wouldCompleteRoundTrip(db, "TSLA", "sell", "2026-08-18") === true);
  check("no false positive", wouldCompleteRoundTrip(db, "MSFT", "sell", "2026-08-18") === false);

  const guard = dayTradeGuard(1); // max 1 → the TSLA close would be #2
  const broker = mockBroker();
  const res = await placeOrder(db, broker, {
    owner: "wld", symbol: "TSLA", intent: "sell", side: "sell", type: "market",
    qty9: d9("1"), estPrice9: d9("100"), asOfDate: "2026-08-18", configVersion: "t",
  }, { washBlacklistDays: 31, extraGuards: [guard] });
  check("gateway refuses day-trade over max", res.placed === false && res.skipped === "DAY_TRADE_GUARD" && broker.submits.length === 0);
}

console.log("v2 book — dial trims:");
{
  const positions = [
    { symbol: "AAA", qty9: d9("10"), price9: d9("100") },  // 1000
    { symbol: "BBB", qty9: d9("5"), price9: d9("200") },   // 1000
  ];
  check("within band: no trims", planDialTrims({ positions, target9: d9("1900"), bandRel: 0.1, minOrder9: d9("25") }).length === 0);
  const plan = planDialTrims({ positions, target9: d9("1100"), bandRel: 0.1, minOrder9: d9("25") });
  check("trims proportional to value", plan.length === 2 && d9str(plan[0].qty9) === "4.5" && d9str(plan[1].qty9) === "2.25");
  const dust = planDialTrims({ positions, target9: d9("1998"), bandRel: 0, minOrder9: d9("25") });
  check("dust legs dropped", dust.length === 0);

  const db = openDb(":memory:");
  ingestFill(db, { id: "t1", symbol: "AAA", side: "buy", qty9: d9("10"), price9: d9("100"), ts: "2026-08-17T14:31:00Z", sleeve: "mom" });
  ingestFill(db, { id: "t2", symbol: "SGOV", side: "buy", qty9: d9("10"), price9: d9("100"), ts: "2026-08-17T14:31:00Z", sleeve: "book" });
  const sv = sleeveValue9(db, "mom", new Map([["AAA", d9("110")], ["SGOV", d9("100")]]));
  check("sleeve value excludes book-owned SGOV", d9str(sv.value9) === "1100" && sv.positions.length === 1);
  const broker = mockBroker();
  const results = await executeTrims(db, broker, "mom", plan, { asOfDate: "2026-08-17", configVersion: "t", washBlacklistDays: 31 });
  check("trims execute as market sells", results.every((r) => r.placed) && broker.submits.every((s) => s.side === "sell"));
  check("trim coids owned by sleeve", results[0].clientOrderId === "mom:AAA:trim:20260817:01");
}

console.log("v2 book — benchmarks + gate:");
{
  const db = openDb(":memory:");
  recordBench(db, "2026-08-17", "SPY", d9("500"));
  recordBench(db, "2026-08-18", "SPY", d9("505"));
  recordBench(db, "2026-08-18", "SPY", d9("506")); // upsert
  const spy = benchSeries(db, "SPY");
  check("bench upsert", spy.length === 2 && d9str(spy[1].value9) === "506");
  const tr = totalReturn(spy);
  check("total return math", tr !== null && Math.abs(tr - 0.012) < 0.0001);

  // Partial window is honestly not green even while beating SPY with low DD.
  seedBook(db, "5000", "2026-08-17");
  markEquity(db, "2026-08-17", new Map());
  markEquity(db, "2026-08-18", new Map());
  const gp = gateProgress(db, { asOfDate: "2026-08-18", ddCeilingPct: 15 });
  check("partial window: not green", gp.green === false && gp.monthsCovered < 12);

  // Fabricate a 12-month green run: book +20% vs SPY +10%, shallow DD.
  const db2 = openDb(":memory:");
  seedBook(db2, "5000", "2025-08-18");
  for (let i = 0; i <= 12; i++) {
    const date = new Date(Date.UTC(2025, 7 + i, 18)).toISOString().slice(0, 10);
    recordCash(db2, { ts: date + "T00:00:00Z", kind: "adjust", amount9: i === 0 ? 0n : d9("83.33"), settlesOn: date, ref: `adj${i}`, note: "test drift" });
    markEquity(db2, date, new Map());
    recordBench(db2, date, "SPY", d9(String(500 + i * 4)));
  }
  const gp2 = gateProgress(db2, { asOfDate: "2026-08-18", ddCeilingPct: 15 });
  check("full green window detected", gp2.green === true && gp2.monthsCovered >= 12 && gp2.beatingSpy === true, JSON.stringify(gp2));

  const basket = wildcardRivalBasket([
    { sleeve: "mom", symbol: "AAA" }, { sleeve: "ins", symbol: "BBB" }, { sleeve: "anc", symbol: "AAA" },
    { sleeve: "wld", symbol: "ZZZ" }, { sleeve: "book", symbol: "SGOV" },
  ]);
  check("wildcard rival basket: other sleeves, deduped, equal-weight", basket.size === 2 && Math.abs((basket.get("AAA") ?? 0) - 0.5) < 1e-9);
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("v2 book: all green");
