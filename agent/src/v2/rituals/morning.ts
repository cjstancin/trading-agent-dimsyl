// Bull v2 — MORNING ritual (Mon–Fri ~09:35 ET). The deterministic open-of-day sequence:
//   market-day gate → reconcile (mismatch → escalate + STOP) → LEI dial (downgrade → trims) →
//   graduated brake → due corporate actions → stop re-place (wld) + insider ATR event check →
//   insider entries (overnight signals) → momentum first-trading-day execution → anchor
//   trade-next-open → wildcard weekly (Mondays) → SGOV sweep LAST.
// Every sub-step runs inside step(): one failure posts a note and the ritual continues (v1 lesson —
// never die silently). Trades place ONLY in mode "auto"; "gated" computes and posts "would have".
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, d9num, mul9, min9, type D9 } from "../decimal.js";
import type { EffectiveConfig } from "../config.js";
import { getState, setState } from "../db.js";
import type { BrokerPort, ReadPort } from "../broker.js";
import type { MarketDayCheck } from "../../market-calendar.js";
import type { Sleeve } from "../types.js";
import { reconcileBoot } from "../reconcile.js";
import { resolveDial, scalarFor, type DialConfig, type DialPosition, type DialState, type LeiReading } from "../book/lei-dial.js";
import { updateBrake, tier3Plan, type BrakeConfig, type BrakeState } from "../book/brake.js";
import { planDialTrims, executeTrims, sleeveValue9 } from "../book/trims.js";
import { runSweep, decideSweep } from "../book/sweep.js";
import { ledgerPosition, ledgerPositions } from "../lots.js";
import { settledCash } from "../settled-cash.js";
import { openBuyReservations9 } from "../order-gateway.js";
import { HARD_FLOOR_FRACTION } from "../judgment/thesis-check.js";
import { tradeNote, skipNote, escalationNote } from "../surfaces/notes.js";
import { morningReplaceStops } from "../sleeves/wildcard/stops.js";
import { runWeeklyPicks, type WildcardPorts } from "../sleeves/wildcard/run.js";
import { loadMeta as loadWldMeta } from "../sleeves/wildcard/store.js";
import { gatherSnapshots, decideEntries, executeEntries, insHeld } from "../sleeves/insider/planner.js";
import { listMetas, atrStopLevel9, emitStopFired } from "../sleeves/insider/exits.js";
import type { MarketPort, SectorPort, DailyBar as InsDailyBar } from "../sleeves/insider/ports.js";
import { markShadow } from "../sleeves/insider/shadow.js";
import { ensureMomTables } from "../sleeves/momentum/schema.js";
import { planRebalance, executeRebalance, momHoldingsFromLedger, computeVolBrake, type Holding } from "../sleeves/momentum/planner.js";
import type { MomentumConfig, PricePort as MomPricePort } from "../sleeves/momentum/ports.js";
import { tradeNextOpen, PENDING_KEY as ANC_PENDING_KEY } from "../sleeves/anchor/index.js";
import type { PricePort as AncPricePort } from "../sleeves/anchor/types.js";
import { pendingEntrySignals } from "./insider-signals.js";
import { morningCorpActions } from "./corp-actions.js";
import {
  step, numToD9, bookEquity9, sleeveEquityFor9, priceMap9, sleeveSymbols, ownerSleeveFor,
  avgEntryPrice9, queueApprovalRow,
  type CoreDeps, type StepResult, type DailyBarsFn, type AlpacaBarLike, type LatestPriceFn,
} from "./support.js";

export const MOM_EXECUTED_MONTH_KEY = "mom:executed-month";

/** Sleeve deployments that are PENDING but not yet reservable at the gateway (planned, not
 *  placed): an unexecuted momentum month, queued insider signals, a pending anchor rebuild, and —
 *  when the weekly pick run is next trading day (Friday's sweep, T+1 settle) — the wildcard gap.
 *  The sweep treats this as spoken-for cash (design §1: SGOV is liquidated FIRST whenever a
 *  sleeve needs cash). Launch week proved the gap: the 09:35 sweep parked momentum's whole
 *  allocation 55 minutes before its 10:30 execution window and all ten buys skipped
 *  NO_SETTLED_CASH. Padded 1% for price drift — over-reserving just leaves cash unswept a day. */
export async function pendingSleeveNeeds9(
  db: DatabaseSync, eff: EffectiveConfig, latest: LatestPriceFn, opts: { reserveWildcard: boolean },
): Promise<{ total9: D9; parts: string[] }> {
  ensureMomTables(db);
  const parts: string[] = [];
  let total9 = 0n;
  const gapFor = async (sleeve: Sleeve): Promise<D9> => {
    const prices = await priceMap9(sleeveSymbols(db, sleeve), latest);
    const deployed9 = sleeveValue9(db, sleeve, prices).value9;
    const gap = sleeveEquityFor9(db, eff, sleeve) - deployed9;
    return gap > 0n ? gap : 0n;
  };
  const month = (db.prepare("SELECT MAX(month) AS m FROM mom_ranks").get() as { m: string | null } | undefined)?.m ?? null;
  const momDone = getState(db, MOM_EXECUTED_MONTH_KEY);
  if (month && (!momDone || momDone < month)) {
    const gap = await gapFor("mom");
    if (gap > 0n) { total9 += gap; parts.push(`momentum ${month} rebalance $${d9str(gap)}`); }
  }
  const insPending = pendingEntrySignals(db).length;
  if (insPending > 0) {
    const slot9 = mul9(d9(String(insPending)), d9(String(eff.config.insider.capacity.slotCeilUsd)));
    const need = min9(slot9, await gapFor("ins"));
    if (need > 0n) { total9 += need; parts.push(`${insPending} insider signal(s) $${d9str(need)}`); }
  }
  if (getState(db, ANC_PENDING_KEY)) {
    const gap = await gapFor("anc");
    if (gap > 0n) { total9 += gap; parts.push(`anchor rebuild $${d9str(gap)}`); }
  }
  if (opts.reserveWildcard) {
    const gap = await gapFor("wld");
    if (gap > 0n) { total9 += gap; parts.push(`wildcard weekly $${d9str(gap)}`); }
  }
  return { total9: mul9(total9, d9("1.01")), parts };
}

export interface MorningDeps extends CoreDeps {
  broker: BrokerPort;
  read: ReadPort;
  marketDay: () => Promise<MarketDayCheck>;
  leiReading: () => LeiReading | null;
  spyAbove200dma: () => Promise<boolean | null>;
  dailyBars: DailyBarsFn;
  insMarket: MarketPort;
  insSector: SectorPort;
  momPrices: MomPricePort | null;       // null → local vol brake not computable (treated inactive, noted)
  wldPorts: WildcardPorts;
  ancPrices: AncPricePort;
  weekday: () => number;                // ET weekday (1 = Monday → wildcard runs)
  nowEtMinutes?: () => number;          // momentum execution-window clock (tests pin it)
  sleep?: (ms: number) => Promise<void>;
  pollTries?: number;
  pollDelayMs?: number;
}

export interface MorningResult {
  ok: boolean;
  skipped?: string;
  halted?: boolean;
  steps: StepResult[];
}

const DIAL_RANK: Record<DialPosition, number> = { engage: 2, caution: 1, pullback: 0 };

function insBars(bars: AlpacaBarLike[]): InsDailyBar[] {
  return bars.map((b) => ({ date: String(b.t).slice(0, 10), close9: numToD9(b.c), volume9: numToD9(b.v) }));
}

export async function runMorningRitual(deps: MorningDeps): Promise<MorningResult> {
  const { db, eff, today, post, broker, read, latestPrice } = deps;
  const cfg = eff.config;
  const steps: StepResult[] = [];
  const tradesAllowed = deps.mode === "auto";
  const washDays = Number(cfg.ledger.washBlacklistDays);

  if (deps.mode === "off") return { ok: true, skipped: "mode=off", steps };
  const day = await deps.marketDay();
  if (!day.open) {
    await post(`🐂 Bill v2 — market closed today (${day.date}): ${day.reason}. Morning ritual skipped.`).catch(() => {});
    return { ok: true, skipped: day.reason, steps };
  }

  // ---- 1 · reconcile: the ledger must explain the account before anything trades. --------------
  let reconOk = false;
  await step(steps, post, "reconcile", async () => {
    const rep = await reconcileBoot(db, broker, read, { stuckOrderMinutes: Number(cfg.ledger.stuckOrderMinutes) });
    if (!rep.ok) {
      await post(escalationNote({
        kind: "reconcile-mismatch",
        title: `reconciliation mismatch — ${rep.mismatches.length} position(s), ${rep.untaggedFills.length} untagged fill(s); affected sleeves HALTED`,
        detail: rep.mismatches.map((m) => `${m.symbol}: ledger ${m.ledger9} vs broker ${m.broker9} (halted: ${m.haltedSleeves.join(",")})`).join(" · ")
          || rep.notes.join(" · "),
      }));
      return `MISMATCH (${rep.mismatches.length})`;
    }
    reconOk = true;
    return `fills +${rep.newFills}, disposals +${rep.newDisposals}, unknown intents resolved ${rep.resolvedUnknownIntents}`;
  });
  if (!reconOk) {
    // A mismatch (or a reconcile that couldn't run) means the cash truth is suspect — stop here.
    return { ok: false, halted: true, steps };
  }

  // ---- 2 · LEI dial (downgrade → trims for the dialed sleeves). --------------------------------
  const dialCfg: DialConfig = {
    stages: cfg.book.leiDial.stages,
    appliesTo: cfg.book.leiDial.appliesTo,
    staleAfterDays: Number(cfg.book.leiDial.staleAfterDays),
    stageMap: cfg.book.leiDial.stageMap,
  };
  let dial: (DialState & { changed: boolean; previous?: DialPosition }) | null = null;
  await step(steps, post, "lei-dial", async () => {
    dial = resolveDial(db, {
      cfg: dialCfg, reading: deps.leiReading(), today, spyAbove200dma: await deps.spyAbove200dma(),
    });
    if (dial.changed) {
      await post(`🎚️ [Book] LEI dial ${dial.previous} → ${dial.position} (scalar ${dial.scalar}, source ${dial.source})${dial.flags.length ? `\n> ${dial.flags.join(" · ")}` : ""}`);
    }
    const downgraded = dial.changed && dial.previous && DIAL_RANK[dial.position] < DIAL_RANK[dial.previous];
    if (downgraded) {
      for (const s of dialCfg.appliesTo) {
        const prices = await priceMap9(sleeveSymbols(db, s), latestPrice);
        const sv = sleeveValue9(db, s, prices);
        if (!sv.positions.length) continue;
        const target9 = mul9(sleeveEquityFor9(db, eff, s), d9(String(dial.scalar)));
        const plan = planDialTrims({
          positions: sv.positions, target9,
          bandRel: Number(cfg.book.leiDial.trimBandRel),
          minOrder9: d9(String(cfg.momentum.holdings.minOrderUsd)),
        });
        if (!plan.length) continue;
        if (!tradesAllowed) {
          for (const t of plan) await post(`⏸️ [${s}] mode=${deps.mode}: would TRIM ${d9str(t.qty9)} sh ${t.symbol} (dial downgrade) — not placed.`);
          continue;
        }
        const results = await executeTrims(db, broker, s, plan, { asOfDate: today, configVersion: eff.version, washBlacklistDays: washDays });
        for (let i = 0; i < plan.length; i++) {
          const r = results[i];
          if (r.placed) {
            await post(tradeNote({ sleeve: s, symbol: plan[i].symbol, side: "sell", intent: "trim", qty: d9str(plan[i].qty9), reason: `dial downgrade → ${dial.position}` }));
          } else {
            await post(skipNote(s, plan[i].symbol, r.skipped ?? "REJECTED", r.detail));
          }
        }
      }
    }
    return `${dial.position} (${dial.source})${dial.changed ? ` — changed from ${dial.previous}` : ""}`;
  });
  // Dial unresolvable → conservative pullback scalar for the dialed sleeves (decideDial's own dark fallback).
  const scalarForSleeve = (s: Sleeve): number =>
    dial ? scalarFor(s, dial, dialCfg) : (dialCfg.appliesTo.includes(s) ? Number(dialCfg.stages.pullback) : 1.0);

  // ---- 3 · graduated brake. Unresolvable brake → block new buys (conservative). ----------------
  let brake: BrakeState = { tier: 3, ddPct: 0, peak9: "0", sizeFactor: 0, newBuysAllowed: false, escalate: false };
  await step(steps, post, "brake", async () => {
    const prevTier = Number(getState(db, "brake:tier") ?? "0");
    brake = updateBrake(db, bookEquity9(db, eff), cfg.book.brake as BrakeConfig);
    if (brake.tier !== prevTier) {
      await post(`🛑 [Book] brake tier ${prevTier} → ${brake.tier} (drawdown ${brake.ddPct.toFixed(2)}% from peak $${brake.peak9})`);
    }
    if (brake.escalate) {
      const floorFrac = Number(HARD_FLOOR_FRACTION);
      const positions: { sleeve: string; symbol: string; price: number; floor?: number }[] = [];
      for (const [symbol, qty] of ledgerPositions(db)) {
        if (symbol === cfg.book.sweep.etf || qty <= 0n) continue;
        const sleeve = ownerSleeveFor(db, symbol);
        const price = (await latestPrice(symbol)) ?? 0;
        let floor: number | undefined;
        if (sleeve === "wld") {
          const m = loadWldMeta(db, symbol);
          if (m) floor = m.entryPrice * floorFrac;
        } else if (sleeve === "ins") {
          const entry = avgEntryPrice9(db, "ins", symbol);
          if (entry != null) floor = d9num(entry) * floorFrac;
        }
        positions.push({ sleeve, symbol, price, ...(floor != null ? { floor } : {}) });
      }
      const plan = tier3Plan(positions);
      queueApprovalRow(db, "brake-tier3", "Brake tier 3 — liquidation plan needs your call", plan);
      await post(escalationNote({
        kind: "brake-tier3",
        title: `book −${brake.ddPct.toFixed(1)}% from peak — tier-3 plan filed (${plan.autoSell.length} below floor, ${plan.needsCall.length} need your call). Nothing sells without your click.`,
      }));
    }
    return `tier ${brake.tier} (dd ${brake.ddPct.toFixed(2)}%)`;
  });

  // ---- 4 · corporate actions due today (splits/dividends applied; exits routed as sleeve sells).
  await step(steps, post, "corporate-actions", async () => {
    const res = await morningCorpActions(db, broker, eff, { today, tradesAllowed, latestPrice, post });
    return `splits ${res.splitsApplied}, dividends ${res.dividendsCredited}, exits ${res.exitsPlaced.length}` +
      (res.missedExits.length ? `, MISSED ${res.missedExits.join(",")}` : "");
  });

  // ---- 5 · morning stops: wildcard day-TIF re-place + insider bot-side ATR event check. --------
  const atrCfg = cfg.wildcard.atrStop as { atrDays: number; multiple: number };
  await step(steps, post, "morning-stops", async () => {
    let placedN = 0;
    if (tradesAllowed) {
      const r = await morningReplaceStops(db, broker, {
        bars: (symbol, minBars) => deps.dailyBars(symbol, minBars * 2 + 15),
        latest: latestPrice,
      }, {
        asOfDate: today, configVersion: eff.version,
        atrDays: Number(atrCfg.atrDays), multiple: Number(atrCfg.multiple), washBlacklistDays: washDays,
      });
      placedN = r.placed.length;
      for (const p of r.placed) await post(tradeNote({ sleeve: "wld", symbol: p.symbol, side: "sell", intent: "stop", protection: `ATR stop ${p.stopPrice} (ratchets, day-TIF)` }));
      for (const s of r.skipped) await post(skipNote("wld", s.symbol, "STOP_SKIP", s.why));
    } else {
      await post(`⏸️ [Wildcard] mode=${deps.mode}: stop re-place computes nothing to send — broker stops not re-placed (ratchet unchanged).`);
    }
    // Insider bot-side ATR check — EVENT ONLY (the sleeve never auto-sells on price; the evening
    // thesis-check owns the consequence). Insider config carries no ATR dials by design — the
    // ritual supplies the wildcard ATR params (documented deviation, see report).
    let insEvents = 0;
    for (const { symbol, meta } of listMetas(db)) {
      if (meta.stopFired || meta.thesisReview) continue;
      const qty = ledgerPosition(db, symbol);
      if (qty <= 0n) continue;
      const bars = insBars(await deps.dailyBars(symbol, Number(atrCfg.atrDays) * 3 + 20));
      const stop = atrStopLevel9(bars, meta.resetDate ?? meta.entryDate, Number(atrCfg.atrDays), Number(atrCfg.multiple));
      const last = bars.length ? bars[bars.length - 1].close9 : null;
      if (stop !== null && last !== null && last < stop) {
        if (emitStopFired(db, symbol, meta, last, stop, new Date().toISOString())) {
          insEvents++;
          await post(`🛡️ [Insider] ${symbol} touched its ATR stop level (${d9str(last)} < ${d9str(stop)}) — thesis-check queued for tonight; no auto-sell.`);
        }
      }
    }
    return `wld stops placed ${placedN}, ins stop events ${insEvents}`;
  });

  // ---- 6 · insider entries (overnight signals → next-open entries; dial-EXEMPT by design). -----
  await step(steps, post, "insider-entries", async () => {
    const pend = pendingEntrySignals(db);
    if (!pend.length) return "no pending signals";
    const benchSym = String(cfg.benchmarks.ins);
    const bpx = await latestPrice(benchSym);
    const benchPx9 = bpx != null ? numToD9(bpx) : null;
    if (!brake.newBuysAllowed) {
      for (const p of pend) {
        markShadow(db, p.cluster.clusterId, { reason: "BRAKE", entryDate: today, entryPx9: null, benchEntryPx9: benchPx9 });
        await post(skipNote("ins", p.cluster.symbol, "BRAKE", `tier ${brake.tier} blocks new buys — signal to shadow book`));
      }
      return `brake blocked ${pend.length} signal(s)`;
    }
    const clusters = pend.map((p) => p.cluster);
    const snaps = await gatherSnapshots(deps.insMarket, deps.insSector, clusters);
    const sleeveUsd = d9num(sleeveEquityFor9(db, eff, "ins"));
    let decisions = decideEntries(snaps, insHeld(db), sleeveUsd, cfg.insider.capacity, cfg.insider.liquidity);
    // Book-wide tier-1 halving applies to insider NOTIONAL sizing; the LEI dial deliberately does
    // NOT (contrarian sleeve exemption, design §2).
    if (brake.tier === 1) {
      decisions = decisions.map((d) => d.kind === "fund" ? { ...d, notional9: mul9(d.notional9, d9("0.5")) } : d);
    }
    if (!tradesAllowed) {
      for (const d of decisions) {
        if (d.kind === "shadow") await post(skipNote("ins", d.symbol, d.reason));
        else await post(`⏸️ [Insider] mode=${deps.mode}: would BUY ${d.symbol} ${d.kind === "fund" ? `$${d9str(d.notional9)}` : `${d9str(d.qty9)} sh limit ${d9str(d.limitPrice9)}`} — not placed (signal stays pending).`);
      }
      return `gated — ${decisions.length} decision(s) computed, nothing placed`;
    }
    const res = await executeEntries(db, broker, {
      clusters, decisions, signalDate: pend[0].signalDate, entryDate: today,
      configVersion: eff.version, washBlacklistDays: washDays,
      horizonTradingDays: Number(cfg.insider.exit.horizonTradingDays),
      clusterResetMaxMonths: Number(cfg.insider.exit.clusterResetMaxMonths),
      benchEntryPx9: benchPx9,
    });
    for (const r of res) {
      if (r.outcome === "placed") await post(tradeNote({ sleeve: "ins", symbol: r.symbol, side: "buy", intent: "buy", thesis: "insider cluster entry (next open)", protection: "126-session horizon + reversal + ATR event → thesis-check" }));
      else if (r.outcome === "clock-reset") await post(`🔁 [Insider] ${r.symbol}: new qualifying cluster on a held name — horizon clock reset once, no added capital.`);
      else if (r.outcome === "cash-retry") await post(`⏳ [Insider] ${r.symbol}: entry deferred — settled cash parked; the sweep frees SGOV and the signal retries next open.`);
      else await post(skipNote("ins", r.symbol, r.reason ?? r.outcome));
    }
    return `${res.filter((r) => r.outcome === "placed").length}/${pend.length} entered`;
  });

  // ---- 7 · momentum first-trading-day execution (deployScalar × brake sizeFactor). -------------
  await step(steps, post, "momentum-rebalance", async () => {
    ensureMomTables(db);
    const monthRow = db.prepare("SELECT MAX(month) AS m FROM mom_ranks").get() as { m: string | null } | undefined;
    const month = monthRow?.m ?? null;
    if (!month) return "no ranks yet";
    const done = getState(db, MOM_EXECUTED_MONTH_KEY);
    if (done && done >= month) return `month ${month} already executed`;
    const momCfg = cfg.momentum as MomentumConfig;
    const ranked = (db.prepare(
      "SELECT symbol FROM mom_ranks WHERE month=? AND final_rank IS NOT NULL ORDER BY final_rank ASC",
    ).all(month) as { symbol: string }[]).map((r) => r.symbol);
    if (!ranked.length) return `month ${month} has no survivors`;

    const heldQty = momHoldingsFromLedger(db);
    const holdings = new Map<string, Holding>();
    const unpriced: string[] = [];
    for (const [sym, qty] of heldQty) {
      const p = await latestPrice(sym);
      if (p == null) unpriced.push(sym);
      else holdings.set(sym, { qty9: qty, price9: numToD9(p) });
    }
    if (unpriced.length) await post(skipNote("mom", unpriced.join(","), "NO_PRICE", "held name(s) unpriced — excluded from this plan"));

    const deployScalar = scalarForSleeve("mom") * (brake.tier === 1 ? 0.5 : 1);
    let volBrakeActive = false;
    if (deps.momPrices && heldQty.size) {
      try {
        volBrakeActive = (await computeVolBrake(deps.momPrices, [...heldQty.keys()], momCfg, today)).active;
      } catch {
        await post(skipNote("mom", "SPY", "VOL_BRAKE_UNKNOWN", "20d vol check failed — treated INACTIVE this run"));
      }
    }
    const plan = planRebalance({
      ranked, holdings, sleeveEquity9: sleeveEquityFor9(db, eff, "mom"), cfg: momCfg,
      deployScalar, volBrakeActive,
    });
    let buys = plan.buys;
    if (!brake.newBuysAllowed && buys.length) {
      for (const b of buys) await post(skipNote("mom", b.symbol, "BRAKE", `tier ${brake.tier} blocks new buys`));
      buys = [];
    }
    for (const d of plan.dropped) await post(skipNote("mom", d.order.symbol, "MIN_ORDER", d.why));
    if (plan.deferred.length) await post(skipNote("mom", plan.deferred.map((o) => o.symbol).join(","), "VOL_BRAKE", "adds deferred (20d sleeve vol > 2× SPY)"));
    if (!tradesAllowed) {
      await post(`⏸️ [Momentum] mode=${deps.mode}: would rebalance ${month} — ${plan.sells.length} sell(s), ${buys.length} buy(s) at ~$${d9str(plan.perName9)}/name — not placed.`);
      return `gated — plan computed for ${month}`;
    }
    const exec = await executeRebalance(db, broker, { ...plan, buys }, {
      asOfDate: today, configVersion: eff.version, washBlacklistDays: washDays, cfg: momCfg,
      ...(deps.nowEtMinutes ? { nowEtMinutes: deps.nowEtMinutes } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.pollTries != null ? { pollTries: deps.pollTries } : {}),
      ...(deps.pollDelayMs != null ? { pollDelayMs: deps.pollDelayMs } : {}),
    });
    if (!exec.executed) {
      await post(`⏳ [Momentum] rebalance for ${month} pending — ${exec.reason}.`);
      return `not executed: ${exec.reason}`;
    }
    // A rebalance that placed NOTHING because settled cash was parked is not "executed" — the
    // month stays owed, the sweep sees the pending need and frees SGOV, and tomorrow's run
    // retries (fresh per-date key). Launch day burned the month on placed 0 / skipped 10.
    const cashStarved = exec.placed.length === 0 && exec.skipped.some((s) => s.skip === "NO_SETTLED_CASH");
    if (cashStarved) {
      await post(`⏳ [Momentum] rebalance for ${month} fully cash-skipped — month NOT marked done; the sweep frees SGOV and tomorrow retries.`);
    } else {
      setState(db, MOM_EXECUTED_MONTH_KEY, month);
    }
    for (const p of exec.placed) await post(tradeNote({ sleeve: "mom", symbol: p.symbol, side: p.side as "buy" | "sell", intent: p.side, reason: p.side === "sell" ? "monthly re-rank" : "monthly rebalance", fillPrice: undefined }));
    for (const s of exec.skipped) await post(skipNote("mom", s.symbol, s.skip, s.detail));
    return `executed ${month}: placed ${exec.placed.length}, skipped ${exec.skipped.length}`;
  });

  // ---- 8 · anchor trade-next-open (only when a gated rebuild marker is pending). ---------------
  await step(steps, post, "anchor-trade", async () => {
    if (!getState(db, "anc:pending_rebuild")) return "no pending rebuild";
    if (!tradesAllowed) {
      await post(`⏸️ [Anchor] mode=${deps.mode}: rebuild marker pending — would trade next auto morning (marker kept).`);
      return "gated — marker kept";
    }
    const res = await tradeNextOpen(db, broker, deps.ancPrices, eff, {
      asOfDate: today, sleeveEquity9: sleeveEquityFor9(db, eff, "anc"),
    });
    if (res.execute) {
      await post(`🏛️ [Anchor] rebuild traded (${res.reason}): ${res.execute.placed} placed, ${res.execute.refused.length} refused${res.problems?.length ? ` · problems: ${res.problems.join("; ")}` : ""}`);
      for (const r of res.execute.refused) await post(skipNote("anc", r.symbol, r.result.skipped ?? "REJECTED", r.result.detail));
    }
    return res.traded ? `traded (${res.reason})` : `not traded (${res.reason})`;
  });

  // ---- 9 · wildcard weekly pick run (Mondays; deployScalar × brake). ---------------------------
  await step(steps, post, "wildcard-weekly", async () => {
    if (deps.weekday() !== 1) return "not Monday";
    if (!brake.newBuysAllowed) {
      await post(skipNote("wld", "(pool)", "BRAKE", `tier ${brake.tier} blocks new buys — weekly pick run deferred`));
      return "brake blocked";
    }
    if (!tradesAllowed) {
      await post(`⏸️ [Wildcard] mode=${deps.mode}: would run the weekly pick protocol — not run (fresh-context call spends money only when it can act).`);
      return "gated";
    }
    const deployScalar = scalarForSleeve("wld") * (brake.tier === 1 ? 0.5 : 1);
    const res = await runWeeklyPicks(db, broker, deps.wldPorts, {
      asOfDate: today,
      leiStage: dial?.leiStage ?? dial?.position ?? "unknown",
      deployScalar,
      sleeveEquity9: sleeveEquityFor9(db, eff, "wld"),
      configVersion: eff.version, cfg, latestPrice,
    });
    for (const o of res.orders) {
      if (o.placed) await post(tradeNote({ sleeve: "wld", symbol: o.symbol, side: o.side, intent: o.side, reason: "weekly pick protocol" }));
      else await post(skipNote("wld", o.symbol, o.skipped ?? "REJECTED"));
    }
    return `${res.action}${res.reason ? ` (${res.reason})` : ""} — ${res.orders.length} order(s), ${res.cardsSent} card(s)`;
  });

  // ---- 10 · SGOV sweep LAST (idle settled cash after every sleeve had its turn). ---------------
  await step(steps, post, "sgov-sweep", async () => {
    const etf = String(cfg.book.sweep.etf);
    const px = await latestPrice(etf);
    if (px == null) {
      await post(skipNote("book", etf, "NO_PRICE", "sweep skipped this run"));
      return "no price";
    }
    // Spoken-for cash the sweep must leave alone: open buy reservations (entries placed this
    // morning, fills not yet replayed) PLUS pending sleeve deployments that are planned but not
    // yet placed (an unexecuted momentum month, queued insider signals, a pending anchor rebuild,
    // Friday's wildcard reserve). Short of the total → the sweep SELLS SGOV to cover (T+1 settle).
    const pending = await pendingSleeveNeeds9(db, eff, latestPrice, { reserveWildcard: deps.weekday() === 5 });
    const reserved9 = openBuyReservations9(db) + pending.total9;
    if (pending.parts.length) {
      await post(`🏦 [Book] sweep holding back pending deployments: ${pending.parts.join(" · ")}`);
    }
    if (!tradesAllowed) {
      const plan = decideSweep({
        settled9: settledCash(db, today), float9: d9(String(cfg.book.sweep.floatUsd)), need9: reserved9,
        sgovQty9: ledgerPosition(db, etf), sgovPrice9: numToD9(px),
      });
      await post(`⏸️ [Book] mode=${deps.mode}: sweep would ${plan.action}${plan.action === "buy" ? ` $${d9str(plan.notional9!)}` : plan.action === "sell" ? ` ${d9str(plan.qty9!)} sh` : ""} (${plan.reason}) — not placed.`);
      return `gated — would ${plan.action}`;
    }
    const { plan, result } = await runSweep(db, broker, {
      cfg: { etf, floatUsd: Number(cfg.book.sweep.floatUsd) }, asOfDate: today,
      configVersion: eff.version, sgovPrice9: numToD9(px), washBlacklistDays: washDays,
      need9: reserved9,
    });
    if (plan.action === "none") return plan.reason;
    if (result?.placed) {
      await post(tradeNote({
        sleeve: "book", symbol: etf, side: plan.action, intent: "sweep",
        notional: plan.notional9 != null ? d9str(plan.notional9) : undefined,
        qty: plan.qty9 != null ? d9str(plan.qty9) : undefined,
        reason: plan.reason,
      }));
    } else {
      await post(skipNote("book", etf, result?.skipped ?? "REJECTED", result?.detail));
    }
    return `${plan.action} (${plan.reason})`;
  });

  return { ok: steps.every((s) => s.ok), steps };
}
