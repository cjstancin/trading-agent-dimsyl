// Bull v2 — Wildcard weekly pick run (design §6). The one orchestration path:
//   pool (own signals only, HELD NAMES EXCLUDED — not re-litigated)
//     → context cards (schema-fixed, budgeted, extractive)
//     → PickPort.rankPool (fresh context every call: nothing from last week's reasoning, no
//       memory, no prior verdicts — sycophancy-amplifier findings)
//     → hard validation (ONE bad item → whole response rejected → book KEPT, logged)
//     → churn engine (code-enforced min-hold / cooldown / max-1-change)
//     → sells first, then equal-sized deployScalar-scaled buys, ALL through the order gateway
//     → position_meta rows carry {thesis, invalidation_level, entry, peak, atrStop}.
// Every run — applied, kept, or noop — lands one wld_picks audit row with the pool, the cards, the
// raw response, and what code actually did with it.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9num } from "../../decimal.js";
import { getState, setState } from "../../db.js";
import { ledgerPosition } from "../../lots.js";
import { placeOrder, type PlaceResult } from "../../order-gateway.js";
import type { BrokerPort } from "../../broker.js";
import type { D9, LatestPriceFn, PickPort, PoolPort, WldPosMeta } from "./types.js";
import type { CardPort } from "./types.js";
import { assemblePool } from "./pool.js";
import { buildCard, PICK_SCHEMA_INSTRUCTION, type BuiltCard } from "./card.js";
import { validatePickResponse } from "./validate.js";
import { planChurn, weeksAgo, weeksBetween, type ChurnPlan } from "./churn.js";
import { pickCount, perBuyNotional9 } from "./planner.js";
import {
  SLEEVE, ensureWildcardTables, heldPositions, loadMeta, logBookEvent, recentExits, recordPickRun, saveMeta,
} from "./store.js";

const LAST_RUN_KEY = "wld:last_pick_week";

export interface WildcardPorts {
  pool: PoolPort;
  card: CardPort;
  pick: PickPort;
}

export interface WeeklyRunOpts {
  asOfDate: string;          // ET date key
  leiStage: string;          // book layer's LEI stage string (goes on every card)
  deployScalar?: number;     // book layer supplies 1.0 / 0.7 / 0.55; defaults to 1.0
  sleeveEquity9: D9;         // book layer's wld sleeve equity (positions + sleeve cash)
  configVersion: string;     // stamped on orders + the audit row
  cfg: any;                  // loadConfig().config — the EFFECTIVE config object
  latestPrice: LatestPriceFn;
}

export interface WeeklyRunResult {
  action: "applied" | "kept_last_book" | "noop";
  reason?: string;
  plan?: ChurnPlan;
  orders: { symbol: string; side: "buy" | "sell"; placed: boolean; coid?: string; skipped?: string }[];
  cardsSent: number;
}

export async function runWeeklyPicks(
  db: DatabaseSync,
  broker: BrokerPort,
  ports: WildcardPorts,
  opts: WeeklyRunOpts,
): Promise<WeeklyRunResult> {
  ensureWildcardTables(db);
  const wcfg = opts.cfg.wildcard;
  const deployScalar = opts.deployScalar ?? 1.0;

  // Weekly cadence guard: the schedule may fire twice (retry, manual poke) — the pick protocol and
  // its 1-change budget are PER WEEK, so a second run inside the same week is a recorded noop.
  const lastRun = getState(db, LAST_RUN_KEY);
  if (lastRun && weeksBetween(lastRun, opts.asOfDate) < 1) {
    return { action: "noop", reason: `already ran this week (${lastRun})`, orders: [], cardsSent: 0 };
  }

  // --- Pool: own signals only, minus EVERY held name (active or mid-exit — a held name is never
  //     re-pitched to the model; code alone re-checks it against its own invalidation).
  const heldAll = heldPositions(db, false);
  const heldSyms = new Set(heldAll.map((h) => h.symbol));
  const pool = (await assemblePool(ports.pool)).filter((e) => !heldSyms.has(e.symbol));

  const audit = (valid: boolean, rejectReason: string | undefined, cards: BuiltCard[], responseRaw: string, action: unknown) =>
    recordPickRun(db, {
      week: opts.asOfDate,
      poolJson: JSON.stringify(pool),
      cardsJson: JSON.stringify(cards.map((c) => c.card)),
      responseRaw,
      valid,
      rejectReason,
      actionJson: JSON.stringify(action),
      configVersion: opts.configVersion,
    });

  if (pool.length === 0) {
    setState(db, LAST_RUN_KEY, opts.asOfDate);
    audit(false, "empty pool", [], "", { action: "noop" });
    return { action: "noop", reason: "empty pool", orders: [], cardsSent: 0 };
  }

  // --- Cards: schema-fixed, budget-enforced, one per pool name.
  const cards: BuiltCard[] = [];
  for (const entry of pool) {
    const [fundamentals, news, pricePath] = await Promise.all([
      ports.card.fundamentals(entry.symbol),
      ports.card.newsClaims(entry.symbol),
      ports.card.pricePath(entry.symbol),
    ]);
    cards.push(buildCard(
      { entry, fundamentals, news, pricePath, leiStage: opts.leiStage, asOf: opts.asOfDate },
      Number(wcfg.contextCardMaxTokens),
    ));
  }

  // --- The LLM call (port boundary) + hard validation. A throw from the port (batch failure,
  //     timeout) is a KEPT book too — the sleeve never trades on a half-answer.
  let raw: unknown;
  try {
    raw = await ports.pick.rankPool(cards.map((c) => c.card), PICK_SCHEMA_INSTRUCTION);
  } catch (e) {
    const reason = `pick port failed: ${e instanceof Error ? e.message : String(e)}`;
    setState(db, LAST_RUN_KEY, opts.asOfDate);
    audit(false, reason, cards, "", { action: "kept_last_book" });
    return { action: "kept_last_book", reason, orders: [], cardsSent: cards.length };
  }
  const responseRaw = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
  const validated = validatePickResponse(raw, new Set(pool.map((p) => p.symbol)));
  if (!validated.ok) {
    setState(db, LAST_RUN_KEY, opts.asOfDate);
    audit(false, validated.reason, cards, responseRaw, { action: "kept_last_book" });
    return { action: "kept_last_book", reason: validated.reason, orders: [], cardsSent: cards.length };
  }

  // --- Churn: code decides what the ranking is allowed to change.
  const active = heldPositions(db, true);
  const heldInputs = [];
  for (const h of active) {
    heldInputs.push({
      symbol: h.symbol,
      enteredOn: h.meta.enteredOn,
      invalidationLevel: h.meta.invalidationLevel,
      latestPrice: await opts.latestPrice(h.symbol),
    });
  }
  const sleeveUsd = d9num(opts.sleeveEquity9);
  const targetCount = pickCount(opts.cfg, sleeveUsd);
  const plan = planChurn({
    asOfDate: opts.asOfDate,
    held: heldInputs,
    picks: validated.picks,
    recentSells: recentExits(db, weeksAgo(opts.asOfDate, Number(wcfg.reentryCooldownWeeks))),
    targetCount,
    cfg: {
      minHoldWeeks: Number(wcfg.minHoldWeeks),
      reentryCooldownWeeks: Number(wcfg.reentryCooldownWeeks),
      maxChangesPerWeek: Number(wcfg.maxChangesPerWeek),
    },
  });

  // --- Execute: sells first (free the slots), then buys. Buy notional = equal split × deployScalar.
  //     A buy the gateway refuses (settled cash still T+1, blacklist) is recorded and simply not
  //     retried until next week's run — no loop, no override.
  const orders: WeeklyRunResult["orders"] = [];
  const gatewayCfg = { washBlacklistDays: Number(opts.cfg.ledger.washBlacklistDays) };

  for (const s of plan.sells) {
    const qty9 = ledgerPosition(db, s.symbol);
    if (qty9 <= 0n) { orders.push({ symbol: s.symbol, side: "sell", placed: false, skipped: "no ledger position" }); continue; }
    // estPrice feeds the gateway's notional floor; live price, else the entry estimate from meta —
    // an exit must never be skipped because a quote was momentarily unavailable.
    const px = (await opts.latestPrice(s.symbol)) ?? loadMeta(db, s.symbol)?.entryPrice ?? 1;
    const res: PlaceResult = await placeOrder(db, broker, {
      owner: SLEEVE, symbol: s.symbol, intent: "sell", side: "sell", type: "market", tif: "day",
      qty9, estPrice9: d9(px.toFixed(4)),
      asOfDate: opts.asOfDate, configVersion: opts.configVersion,
    }, gatewayCfg);
    orders.push({ symbol: s.symbol, side: "sell", placed: res.placed, coid: res.clientOrderId, skipped: res.skipped });
    if (res.placed) {
      const meta = loadMeta(db, s.symbol);
      if (meta) { meta.pendingExit = { reason: s.reason, on: opts.asOfDate }; saveMeta(db, s.symbol, meta); }
      // Cooldown clock starts at the DECISION (conservative: an exit we ordered is an exit).
      logBookEvent(db, s.symbol, "exit", opts.asOfDate, s.reason);
    }
  }

  const buyNotional9 = perBuyNotional9(opts.sleeveEquity9, targetCount, deployScalar);
  for (const b of plan.buys) {
    const res = await placeOrder(db, broker, {
      owner: SLEEVE, symbol: b.pick.ticker, intent: "buy", side: "buy", type: "market", tif: "day",
      notional9: buyNotional9,
      asOfDate: opts.asOfDate, configVersion: opts.configVersion,
    }, gatewayCfg);
    orders.push({ symbol: b.pick.ticker, side: "buy", placed: res.placed, coid: res.clientOrderId, skipped: res.skipped });
    if (res.placed) {
      const px = await opts.latestPrice(b.pick.ticker);
      const entry = px ?? d9num(buyNotional9); // price unknown → placeholder; reconcile refines from the fill
      const meta: WldPosMeta = {
        schema: "wld-pos-v1",
        thesis: b.pick.thesis,
        invalidationLevel: b.pick.invalidation_level,
        conviction: b.pick.conviction_bucket,
        holdingPeriod: b.pick.holding_period,
        whatWouldChangeMyMind: b.pick.what_would_change_my_mind,
        enteredOn: opts.asOfDate,
        pickRank: b.pick.rank,
        entryPrice: entry,
        peak: entry,
        atrStop: null,          // armed by the first morning stop pass
      };
      saveMeta(db, b.pick.ticker, meta);
      logBookEvent(db, b.pick.ticker, "enter", opts.asOfDate, `pick rank ${b.pick.rank} (${b.slot})`);
    }
  }

  setState(db, LAST_RUN_KEY, opts.asOfDate);
  const anyChange = orders.some((o) => o.placed);
  const result: WeeklyRunResult = {
    action: anyChange ? "applied" : "noop",
    reason: anyChange ? undefined : "no eligible changes",
    plan, orders, cardsSent: cards.length,
  };
  audit(true, undefined, cards, responseRaw, { action: result.action, plan, orders: orders.map((o) => ({ ...o })) });
  return result;
}
