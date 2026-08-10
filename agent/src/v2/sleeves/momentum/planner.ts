// Bull v2 — momentum rebalance planner + executor (design §2). planRebalance is PURE: ranked list +
// current holdings + sleeve equity in, {sells, buys} with d9 notionals out — every sizing decision
// is unit-testable without a broker. executeRebalance is the ONLY impure half: it walks the plan
// through the shared order gateway (sells → await terminal → buys) and books honesty costs.
//
// Sizing rules, all from config (never hardcoded here):
//   · equal-weight target = sleeveEquity / N (N from the equity-indexed schedule)
//   · weight band ±25% RELATIVE: a held name trades back to target only OUTSIDE
//     [target×0.75, target×1.25] (= 7.5–12.5% absolute at N=10) — inside the band, sit still
//   · NEW-name buys are scaled by the LEI regime dial's deployScalar (book layer supplies 1.0/0.7/
//     0.55; default 1.0). Band ADDS of existing names are rebalances, not new deployment — unscaled.
//   · min order $25 kills churn trades — EXCEPT rank-out exits, which always run (the monthly
//     re-rank IS the exit mechanism; a position may never be trapped by its own smallness)
//   · local vol brake (20d sleeve vol > 2× SPY) defers ALL adds (new buys + band adds); sells run
//
// Execution discipline: orders only inside the config ET window (10:30–15:00), sells submitted
// first and POLLED to terminal before any buy — sale cash must at least be booked before buys ask
// the settled-cash gate for room. (Strict T+1 means same-day sale proceeds are still unsettled;
// buys that don't fit settled cash get SKIPPED + recorded by the gateway, never forced.)
import type { DatabaseSync } from "node:sqlite";
import { d9, mul9, div9, d9num, type D9 } from "../../decimal.js";
import { getState, setState } from "../../db.js";
import { placeOrder, type PlaceResult } from "../../order-gateway.js";
import type { BrokerPort } from "../../broker.js";
import { nFor, selectTargets, dailyReturns, equalWeightPortfolioReturns, volBrakeActive, vol20d } from "./signal.js";
import { recordHonesty } from "./honesty.js";
import type { MomentumConfig, PricePort } from "./ports.js";

export interface Holding {
  qty9: D9;
  price9: D9;    // current mark — caller supplies (latestPrice or last close), planner never fetches
}

export type OrderReason = "rank-out" | "band-trim" | "band-add" | "new-buy";

export interface PlannedOrder {
  symbol: string;
  side: "buy" | "sell";
  reason: OrderReason;
  qty9?: D9;         // rank-out exits sell the FULL ledger qty (guaranteed flat)
  notional9?: D9;    // band trades + new buys are notional market orders (fractionable universe)
  estPrice9?: D9;    // required by the gateway's notional gates for qty orders
}

export interface RebalancePlan {
  n: number;
  perName9: D9;                                   // equal-weight target dollars per name
  targets: string[];
  sells: PlannedOrder[];                          // rank-out exits first, then band trims
  buys: PlannedOrder[];                           // band adds + new buys (empty when brake active)
  deferred: PlannedOrder[];                       // adds pushed off by the local vol brake
  dropped: { order: PlannedOrder; why: string }[]; // min-order suppressions (visibility, not silence)
}

export interface PlanInput {
  ranked: string[];                  // survivor symbols in final-rank order (signal.computeRanks .final)
  holdings: Map<string, Holding>;    // current sleeve positions (see momHoldingsFromLedger)
  sleeveEquity9: D9;                 // book layer supplies (sleeve slice of book equity)
  cfg: MomentumConfig;
  deployScalar?: number;             // LEI dial: 1.0 | 0.7 | 0.55 — scales NEW-BUY sizing only
  volBrakeActive?: boolean;          // computed via computeVolBrake (or injected in tests)
}

export function planRebalance(input: PlanInput): RebalancePlan {
  const cfg = input.cfg;
  const scalar = input.deployScalar ?? 1.0;
  if (!(scalar > 0 && scalar <= 1)) throw new Error(`planRebalance: deployScalar ${scalar} out of (0,1]`);

  const n = nFor(cfg, d9num(input.sleeveEquity9));
  const held = [...input.holdings.keys()];
  const sel = selectTargets(input.ranked, held, n, cfg.rebalance.buyFromTop, cfg.rebalance.sellBelowRank);

  const perName9 = div9(input.sleeveEquity9, d9(BigInt(n)));
  const lo9 = mul9(perName9, d9(String(1 - cfg.holdings.weightBandRel)));
  const hi9 = mul9(perName9, d9(String(1 + cfg.holdings.weightBandRel)));
  const minOrder9 = d9(String(cfg.holdings.minOrderUsd));
  const scalar9 = d9(String(scalar));

  const sells: PlannedOrder[] = [];
  let buys: PlannedOrder[] = [];
  const dropped: { order: PlannedOrder; why: string }[] = [];

  // Rank-out exits: full-qty sells, NEVER min-order-suppressed (the exit mechanism must fire).
  for (const sym of sel.sells) {
    const h = input.holdings.get(sym)!;
    sells.push({ symbol: sym, side: "sell", reason: "rank-out", qty9: h.qty9, estPrice9: h.price9 });
  }

  // Held names inside the book: trade back to target only OUTSIDE the relative band.
  for (const sym of sel.keeps) {
    const h = input.holdings.get(sym)!;
    const value9 = mul9(h.qty9, h.price9);
    if (value9 > hi9) {
      const order: PlannedOrder = { symbol: sym, side: "sell", reason: "band-trim", notional9: value9 - perName9 };
      if (order.notional9! < minOrder9) dropped.push({ order, why: `below min order $${cfg.holdings.minOrderUsd}` });
      else sells.push(order);
    } else if (value9 < lo9) {
      const order: PlannedOrder = { symbol: sym, side: "buy", reason: "band-add", notional9: perName9 - value9 };
      if (order.notional9! < minOrder9) dropped.push({ order, why: `below min order $${cfg.holdings.minOrderUsd}` });
      else buys.push(order);
    }
    // inside the band → no trade (the whole point of the band)
  }

  // New entries: equal-weight slice × deployScalar (the ONLY sizing the LEI dial touches).
  for (const sym of sel.buys) {
    const order: PlannedOrder = { symbol: sym, side: "buy", reason: "new-buy", notional9: mul9(perName9, scalar9) };
    if (order.notional9! < minOrder9) dropped.push({ order, why: `below min order $${cfg.holdings.minOrderUsd}` });
    else buys.push(order);
  }

  // Local vol brake: defer ALL adds; sells (risk-reducing) always proceed.
  let deferred: PlannedOrder[] = [];
  if (input.volBrakeActive) { deferred = buys; buys = []; }

  return { n, perName9, targets: sel.targets, sells, buys, deferred, dropped };
}

/** Current momentum sleeve holdings straight from the shared FIFO lot table (qty only — caller
 *  marks with prices). Reads lots WHERE sleeve='mom'; never mutates shared tables. */
export function momHoldingsFromLedger(db: DatabaseSync): Map<string, D9> {
  const rows = db
    .prepare("SELECT symbol, qty_remaining9 FROM lots WHERE sleeve='mom'")
    .all() as { symbol: string; qty_remaining9: string }[];
  const out = new Map<string, D9>();
  for (const r of rows) out.set(r.symbol, (out.get(r.symbol) ?? 0n) + d9(r.qty_remaining9));
  for (const [k, v] of out) if (v === 0n) out.delete(k);
  return out;
}

/** 20-day sleeve-vs-SPY vol check via the price port (~70 calendar days of dailies covers 20
 *  trading returns with slack). Equal-weight sleeve proxy — matches how the sleeve is sized. */
export async function computeVolBrake(
  prices: PricePort, holdings: string[], cfg: MomentumConfig, endDate: string, spySymbol = "SPY",
): Promise<{ active: boolean; sleeveVol: number; spyVol: number }> {
  if (!holdings.length) return { active: false, sleeveVol: 0, spyVol: 0 };
  const start = new Date(new Date(endDate + "T12:00:00Z").getTime() - 70 * 86_400_000).toISOString().slice(0, 10);
  const spyBars = await prices.dailyBars(spySymbol, start, endDate);
  const series: number[][] = [];
  for (const sym of holdings) series.push((await prices.dailyBars(sym, start, endDate)).map((b) => b.close));
  const sleeveRets = equalWeightPortfolioReturns(series);
  const spyRets = dailyReturns(spyBars.map((b) => b.close));
  return {
    active: volBrakeActive(sleeveRets, spyRets, cfg.localBrake.vol20dVsSpyMax),
    sleeveVol: vol20d(sleeveRets),
    spyVol: vol20d(spyRets),
  };
}

/** "HH:MM" → minutes since midnight. */
export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`bad HH:MM "${hhmm}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes since ET midnight, now — same pattern as market-calendar.ts (which keeps its private). */
function etMinutesNow(): number {
  const hhmm = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  });
  return hhmmToMinutes(hhmm);
}

const TERMINAL_STATUSES = new Set(["filled", "canceled", "expired", "rejected", "done_for_day", "replaced"]);

/** Poll one coid to a terminal broker status (bounded — an unfilled market order can't pin the
 *  ritual forever). Injectable sleep so tests run in microseconds. */
async function awaitTerminal(
  broker: BrokerPort, coid: string,
  opts: { tries: number; delayMs: number; sleep: (ms: number) => Promise<void> },
): Promise<string | null> {
  for (let i = 0; i < opts.tries; i++) {
    const o = await broker.queryByClientOrderId(coid);
    const status = o?.status ? String(o.status) : null;
    if (status && TERMINAL_STATUSES.has(status)) return status;
    await opts.sleep(opts.delayMs);
  }
  return null;
}

export interface ExecuteOpts {
  asOfDate: string;        // ET date key (YYYY-MM-DD)
  configVersion: string;   // loadConfig().version — stamped on every intent
  washBlacklistDays: number;
  cfg: MomentumConfig;
  nowEtMinutes?: () => number;         // injectable clock (tests); default = real ET wall clock
  sleep?: (ms: number) => Promise<void>;
  pollTries?: number;
  pollDelayMs?: number;
  force?: boolean;         // override the once-per-day guard (operator re-run after a partial day)
}

export interface ExecuteResult {
  executed: boolean;
  reason?: string;         // when refused (window / already-ran)
  placed: { symbol: string; side: string; coid: string; terminal?: string | null }[];
  skipped: { symbol: string; side: string; skip: string; detail?: string }[];
  deferredCount: number;
}

/** Walk the plan through the shared gateway: sells → await terminal → buys. Every refusal the
 *  gateway makes is surfaced in `skipped` (and recorded by the gateway itself — nothing silent).
 *  Guarded once-per-asOfDate: coid seqs are per-day, so a blind re-run would re-place every order. */
export async function executeRebalance(
  db: DatabaseSync, broker: BrokerPort, plan: RebalancePlan, opts: ExecuteOpts,
): Promise<ExecuteResult> {
  const nowMin = (opts.nowEtMinutes ?? etMinutesNow)();
  const [startS, endS] = opts.cfg.rebalance.windowEt;
  if (nowMin < hhmmToMinutes(startS) || nowMin >= hhmmToMinutes(endS)) {
    return { executed: false, reason: `outside rebalance window ${startS}–${endS} ET`, placed: [], skipped: [], deferredCount: plan.deferred.length };
  }
  const doneKey = `mom:rebalance-done:${opts.asOfDate}`;
  if (!opts.force && getState(db, doneKey)) {
    return { executed: false, reason: `already executed for ${opts.asOfDate} (state ${doneKey})`, placed: [], skipped: [], deferredCount: plan.deferred.length };
  }

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollTries = opts.pollTries ?? 30;
  const pollDelayMs = opts.pollDelayMs ?? 2000;
  const placed: ExecuteResult["placed"] = [];
  const skipped: ExecuteResult["skipped"] = [];

  const submit = async (o: PlannedOrder): Promise<PlaceResult> => {
    const res = await placeOrder(db, broker, {
      owner: "mom",
      symbol: o.symbol,
      intent: o.side,
      side: o.side,
      type: "market",
      tif: "day",
      ...(o.qty9 != null ? { qty9: o.qty9 } : {}),
      ...(o.notional9 != null ? { notional9: o.notional9 } : {}),
      ...(o.estPrice9 != null ? { estPrice9: o.estPrice9 } : {}),
      asOfDate: opts.asOfDate,
      configVersion: opts.configVersion,
      blacklistExempt: o.side === "sell",   // exits are exempt by nature; buys face the 31-day blacklist
    }, { washBlacklistDays: opts.washBlacklistDays });
    if (res.placed && res.clientOrderId) {
      const notional9 = o.notional9 ?? mul9(o.qty9!, o.estPrice9!);
      recordHonesty(db, {
        clientOrderId: res.clientOrderId, ts: new Date().toISOString(),
        symbol: o.symbol, side: o.side, notional9,
      }, opts.cfg);
    } else if (!res.placed) {
      skipped.push({ symbol: o.symbol, side: o.side, skip: res.skipped ?? "REJECTED", detail: res.detail });
    }
    return res;
  };

  // Phase 1 — sells, then poll each to terminal before any buy sees the gate.
  const sellCoids: { symbol: string; coid: string }[] = [];
  for (const o of plan.sells) {
    const res = await submit(o);
    if (res.placed && res.clientOrderId) sellCoids.push({ symbol: o.symbol, coid: res.clientOrderId });
  }
  for (const s of sellCoids) {
    const terminal = await awaitTerminal(broker, s.coid, { tries: pollTries, delayMs: pollDelayMs, sleep });
    placed.push({ symbol: s.symbol, side: "sell", coid: s.coid, terminal });
  }

  // Phase 2 — buys (band adds + new buys). The gateway's settled-cash gate has the final word.
  for (const o of plan.buys) {
    const res = await submit(o);
    if (res.placed && res.clientOrderId) placed.push({ symbol: o.symbol, side: "buy", coid: res.clientOrderId });
  }

  setState(db, doneKey, JSON.stringify({ ts: new Date().toISOString(), placed: placed.length, skipped: skipped.length }));
  return { executed: true, placed, skipped, deferredCount: plan.deferred.length };
}
