// Bull v2 — Wildcard ATR trailing-stop engine (design §6). Two cooperating layers:
//   · BOT-SIDE RATCHET — peak-tracked in position_meta: peak only rises, and the stop
//     (peak − multiple × ATR) only rises. A widening ATR or a falling price NEVER lowers an
//     armed stop — monotonicity is the whole point of a ratchet and is unit-tested.
//   · BROKER STOP ORDERS — fractional stop orders are DAY-TIF on Alpaca, so they die at each
//     close and the morning ritual re-places them at the current ratchet level through the order
//     gateway (intent:"stop", blacklistExempt — protective sells are exempt from the re-entry
//     blacklist by nature). The broker order is the gap/outage backstop; the ratchet is the truth.
//
// STOP FIRES → NOT OUR CALL. This sleeve emits a stop_fired event carrying the position's ORIGINAL
// invalidation level + thesis (state key `wld:stop_fired:<SYMBOL>` + the position_meta row) and
// freezes the position (no re-arming, no auto-sell). The judgment layer (design §6 thesis-check,
// Opus-class, 3 judges) owns the sell/hold decision and the hard −25%-from-entry floor. We hand
// over facts, never verdicts.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, type D9 } from "../../decimal.js";
import { setState } from "../../db.js";
import { ledgerPosition } from "../../lots.js";
import { placeOrder } from "../../order-gateway.js";
import type { BrokerPort } from "../../broker.js";
import { SLEEVE, heldPositions, loadMeta, saveMeta } from "./store.js";
import type { Bar, LatestPriceFn, StopFiredEvent, WldPosMeta } from "./types.js";

/** Wilder's ATR over daily bars: TR = max(h−l, |h−prevClose|, |l−prevClose|); seed = SMA of the
 *  first `days` TRs, then Wilder smoothing atr = (atr·(days−1) + tr) / days. Returns null when
 *  there aren't enough bars (days+1 minimum) — callers SKIP rather than guess. Plain number math:
 *  ATR is an analytics input to a stop level, not ledger money; the stop PRICE crosses into d9 at
 *  the order boundary. */
export function computeAtr(bars: Bar[], days: number): number | null {
  if (!Number.isInteger(days) || days < 1 || bars.length < days + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  let atr = trs.slice(0, days).reduce((a, x) => a + x, 0) / days;
  for (let i = days; i < trs.length; i++) atr = (atr * (days - 1) + trs[i]) / days;
  return atr;
}

/** One ratchet step: peak = max(peak, latest); candidate = peak − multiple·ATR; stop = max(stop,
 *  candidate). Pure; both outputs are monotone non-decreasing across any input sequence. */
export function ratchetStep(
  prev: { peak: number; atrStop: number | null },
  latest: number,
  atr: number,
  multiple: number,
): { peak: number; atrStop: number } {
  const peak = Math.max(prev.peak, latest);
  const candidate = peak - multiple * atr;
  const atrStop = prev.atrStop === null ? candidate : Math.max(prev.atrStop, candidate);
  return { peak, atrStop };
}

/** Pure trigger check for the bot-side monitor: has price touched the armed ratchet level? */
export function stopTriggered(meta: WldPosMeta, latest: number): boolean {
  return meta.atrStop !== null && latest <= meta.atrStop;
}

export interface StopsDeps {
  /** Daily bars for the ATR window (real adapter: Alpaca getBars). Must return ≥ atrDays+1 bars. */
  bars(symbol: string, minBars: number): Promise<Bar[]>;
  latest: LatestPriceFn;
}

export interface MorningStopsResult {
  placed: { symbol: string; stopPrice: string; coid?: string }[];
  skipped: { symbol: string; why: string }[];
}

/** Morning ritual: for every ACTIVE wld position, refresh the ratchet from fresh bars and re-place
 *  the day-TIF broker stop at the ratchet level. Positions pending exit or awaiting a thesis-check
 *  are skipped (a market sell or a judgment verdict is already in flight — arming a second sell
 *  path would oversell). Every skip is recorded, never silent. */
export async function morningReplaceStops(
  db: DatabaseSync,
  broker: BrokerPort,
  deps: StopsDeps,
  opts: { asOfDate: string; configVersion: string; atrDays: number; multiple: number; washBlacklistDays: number },
): Promise<MorningStopsResult> {
  const out: MorningStopsResult = { placed: [], skipped: [] };

  for (const { symbol, meta } of heldPositions(db, true)) {
    const qty9 = ledgerPosition(db, symbol);
    if (qty9 <= 0n) { out.skipped.push({ symbol, why: "no ledger position" }); continue; }

    const bars = await deps.bars(symbol, opts.atrDays + 1);
    const atr = computeAtr(bars, opts.atrDays);
    if (atr === null) { out.skipped.push({ symbol, why: "insufficient bars for ATR" }); continue; }

    const latest = (await deps.latest(symbol)) ?? bars[bars.length - 1].c;
    const r = ratchetStep({ peak: meta.peak, atrStop: meta.atrStop }, latest, atr, opts.multiple);
    meta.peak = r.peak;
    meta.atrStop = r.atrStop;
    saveMeta(db, symbol, meta);

    if (r.atrStop <= 0) { out.skipped.push({ symbol, why: "non-positive stop level" }); continue; }

    // Cents precision, rounded DOWN — a stop a fraction lower can only trigger later, never
    // earlier than the bot-side level (the ratchet remains the tighter truth).
    const stopPrice9: D9 = d9((Math.floor(r.atrStop * 100) / 100).toFixed(2));
    const res = await placeOrder(db, broker, {
      owner: SLEEVE, symbol, intent: "stop", side: "sell", type: "stop", tif: "day",
      qty9, stopPrice9, estPrice9: d9(latest.toFixed(4)),
      asOfDate: opts.asOfDate, configVersion: opts.configVersion, blacklistExempt: true,
    }, { washBlacklistDays: opts.washBlacklistDays });

    if (res.placed) out.placed.push({ symbol, stopPrice: d9str(stopPrice9), coid: res.clientOrderId });
    else out.skipped.push({ symbol, why: `gateway: ${res.skipped ?? res.detail ?? "unknown"}` });
  }
  return out;
}

/** A stop fired (broker stop filled, or the bot-side monitor saw price touch the ratchet). Emit the
 *  judgment-layer handoff and freeze the position. Idempotent per symbol: a second call while a
 *  handoff is pending returns the existing event untouched (a re-fired detection must not clobber
 *  the original firedPrice the judges are already looking at). Returns null when we hold no meta
 *  for the symbol (nothing to hand over — reconcile flags the orphan). */
export function emitStopFired(
  db: DatabaseSync,
  symbol: string,
  info: { firedPrice9: D9; ts: string; source: "bot_ratchet" | "broker_fill" },
): StopFiredEvent | null {
  const meta = loadMeta(db, symbol);
  if (!meta) return null;
  if (meta.stopFired) return meta.stopFired;

  const event: StopFiredEvent = {
    schema: "wld-stop-fired-v1",
    sleeve: SLEEVE,
    symbol: symbol.toUpperCase(),
    firedTs: info.ts,
    firedPrice: d9str(info.firedPrice9),
    source: info.source,
    entryPrice: meta.entryPrice,
    peak: meta.peak,
    atrStop: meta.atrStop,
    thesis: meta.thesis,
    invalidationLevel: meta.invalidationLevel,
    whatWouldChangeMyMind: meta.whatWouldChangeMyMind,
    holdingPeriod: meta.holdingPeriod,
    enteredOn: meta.enteredOn,
  };
  meta.stopFired = event;
  saveMeta(db, symbol, meta);
  setState(db, `wld:stop_fired:${event.symbol}`, JSON.stringify(event));
  return event;
}
