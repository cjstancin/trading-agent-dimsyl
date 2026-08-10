// Bull v2 — rituals: corporate-actions glue around book/corporate-actions.ts.
//   · EVENING: poll announcements for held symbols → planCorporateActions → the plan is stored in
//     state (bigint-safe JSON) for the next morning.
//   · MORNING: read the stored plan → applyDueActions (forward splits self-adjust + broker-stale
//     flag; dividends self-credit, idempotent by ref) → exit-before actions (reverse splits,
//     mergers) route as SLEEVE SELLS through the shared gateway + a watchlist exit row.
// Split re-application guard: applyForwardSplit multiplies the ledger every call, so each applied
// split is remembered in state (corp:applied:*) and filtered out of any later apply pass — a
// same-day ritual re-run must not double a position.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, type D9 } from "../decimal.js";
import { getState, setState } from "../db.js";
import { ledgerPosition, ledgerPositions, addDays } from "../lots.js";
import { placeOrder } from "../order-gateway.js";
import type { BrokerPort } from "../broker.js";
import type { EffectiveConfig } from "../config.js";
import {
  planCorporateActions, applyDueActions,
  type CorporateActionsPlan, type CorporateActionsPort,
} from "../book/corporate-actions.js";
import { recordExit } from "../book/watchlist.js";
import { skipNote, tradeNote } from "../surfaces/notes.js";
import { dtGuard, ownerSleeveFor, numToD9, type LatestPriceFn, type PostFn } from "./support.js";

export const CORP_PLAN_KEY = "corp:plan";
const appliedKey = (symbol: string, exDate: string): string => `corp:applied:${symbol}:${exDate}`;

/** CorporateActionsPlan carries bigints (split ratios, d9 dividends) — JSON needs help. */
export function serializeCorpPlan(plan: CorporateActionsPlan): string {
  return JSON.stringify({
    exitBefore: plan.exitBefore,
    forwardSplits: plan.forwardSplits.map((s) => ({ symbol: s.symbol, num: s.num.toString(), den: s.den.toString(), exDate: s.exDate })),
    dividends: plan.dividends.map((dv) => ({ symbol: dv.symbol, exDate: dv.exDate, perShare9: d9str(dv.perShare9) })),
    unknown: plan.unknown.map((u) => ({ symbol: u.symbol, type: u.type, exDate: u.exDate, effectiveDate: u.effectiveDate })),
  });
}

export function deserializeCorpPlan(json: string): CorporateActionsPlan {
  const j = JSON.parse(json) as {
    exitBefore: { symbol: string; type: string; effectiveDate: string }[];
    forwardSplits: { symbol: string; num: string; den: string; exDate: string }[];
    dividends: { symbol: string; exDate: string; perShare9: string }[];
    unknown: { symbol: string; type: string; exDate?: string; effectiveDate?: string }[];
  };
  return {
    exitBefore: j.exitBefore ?? [],
    forwardSplits: (j.forwardSplits ?? []).map((s) => ({ symbol: s.symbol, num: BigInt(s.num), den: BigInt(s.den), exDate: s.exDate })),
    dividends: (j.dividends ?? []).map((dv) => ({ symbol: dv.symbol, exDate: dv.exDate, perShare9: d9(dv.perShare9) })),
    unknown: (j.unknown ?? []).map((u) => ({ symbol: u.symbol, type: u.type as never, exDate: u.exDate, effectiveDate: u.effectiveDate })),
  };
}

export function storeCorpPlan(db: DatabaseSync, plan: CorporateActionsPlan): void {
  setState(db, CORP_PLAN_KEY, serializeCorpPlan(plan));
}

export function readCorpPlan(db: DatabaseSync): CorporateActionsPlan | null {
  const raw = getState(db, CORP_PLAN_KEY);
  return raw ? deserializeCorpPlan(raw) : null;
}

/** EVENING: poll announcements for every held symbol over the next `horizonDays`, store the plan.
 *  A data blip returns an empty announcement list (the adapter's contract) — tomorrow retries. */
export async function nightlyCorpPoll(
  db: DatabaseSync, port: CorporateActionsPort, opts: { today: string; horizonDays?: number },
): Promise<{ plan: CorporateActionsPlan; held: string[] }> {
  const held = [...ledgerPositions(db).keys()];
  let plan: CorporateActionsPlan = { exitBefore: [], forwardSplits: [], dividends: [], unknown: [] };
  if (held.length) {
    const anns = await port.announcements(held, opts.today, addDays(opts.today, opts.horizonDays ?? 14));
    plan = planCorporateActions(anns, new Set(held));
  }
  storeCorpPlan(db, plan);
  return { plan, held };
}

export interface CorpMorningResult {
  splitsApplied: number;
  dividendsCredited: number;
  exitsPlaced: { symbol: string; sleeve: string; coid?: string }[];
  exitsWouldPlace: string[];   // gated mode — computed, not placed
  missedExits: string[];       // effective date already passed — escalated, reconcile will flag
  unknownCount: number;
}

/** MORNING: apply everything due from the stored plan, and route exit-before actions as sleeve
 *  sells (auto mode only). Executed exits are removed from the stored plan so a same-day re-run
 *  can't double-sell; applied splits are remembered in state for the same reason. */
export async function morningCorpActions(
  db: DatabaseSync, broker: BrokerPort, eff: EffectiveConfig,
  opts: { today: string; tradesAllowed: boolean; latestPrice: LatestPriceFn; post: PostFn },
): Promise<CorpMorningResult> {
  const out: CorpMorningResult = {
    splitsApplied: 0, dividendsCredited: 0, exitsPlaced: [], exitsWouldPlace: [], missedExits: [], unknownCount: 0,
  };
  const plan = readCorpPlan(db);
  if (!plan) return out;
  out.unknownCount = plan.unknown.length;

  // Ledger effects due today: splits filtered against the already-applied guard, then remembered.
  const freshSplits = plan.forwardSplits.filter((s) => !getState(db, appliedKey(s.symbol, s.exDate)));
  const applied = applyDueActions(db, { ...plan, forwardSplits: freshSplits }, opts.today);
  out.splitsApplied = applied.splitsApplied;
  out.dividendsCredited = applied.dividendsCredited;
  for (const s of freshSplits) {
    if (s.exDate <= opts.today) {
      setState(db, appliedKey(s.symbol, s.exDate), opts.today);
      await opts.post(`🔀 [Book] forward split ${s.symbol} ${s.num}:${s.den} applied to the ledger (ex ${s.exDate}) — broker position flagged stale until reconcile verifies.`);
    }
  }
  for (const dv of plan.dividends) {
    if (dv.exDate <= opts.today) {
      await opts.post(`💰 [Book] dividend ${dv.symbol} $${d9str(dv.perShare9)}/sh self-credited at ex-date ${dv.exDate} (paper pays no dividends).`);
    }
  }

  // Exit-before actions (reverse splits / mergers) → the owning sleeve's normal sell path.
  const remaining: CorporateActionsPlan["exitBefore"] = [];
  for (const ex of plan.exitBefore) {
    const qty9: D9 = ledgerPosition(db, ex.symbol);
    if (qty9 <= 0n) continue; // already flat — nothing to exit
    if (ex.effectiveDate <= opts.today) {
      out.missedExits.push(ex.symbol);
      await opts.post(`🚨 [Book] ${ex.symbol} ${ex.type} effective ${ex.effectiveDate} has PASSED while still held — reconcile will flag; needs your eyes.`);
      remaining.push(ex);
      continue;
    }
    const sleeve = ownerSleeveFor(db, ex.symbol);
    if (!opts.tradesAllowed) {
      out.exitsWouldPlace.push(ex.symbol);
      await opts.post(`⏸️ [${sleeve}] mode=${"gated"}: would SELL ${ex.symbol} (${ex.type} effective ${ex.effectiveDate}) — not placed.`);
      remaining.push(ex);
      continue;
    }
    const px = await opts.latestPrice(ex.symbol);
    const est9 = px != null ? numToD9(px) : d9("1");
    const res = await placeOrder(db, broker, {
      owner: sleeve, symbol: ex.symbol, intent: "sell", side: "sell", type: "market", tif: "day",
      qty9, estPrice9: est9, asOfDate: opts.today, configVersion: eff.version, blacklistExempt: true,
    }, { washBlacklistDays: Number(eff.config.ledger.washBlacklistDays), extraGuards: [dtGuard(eff)] });
    if (res.placed) {
      out.exitsPlaced.push({ symbol: ex.symbol, sleeve, coid: res.clientOrderId });
      recordExit(db, {
        ts: new Date().toISOString(), sleeve, symbol: ex.symbol,
        reason: `corp-action:${ex.type}`, exitPrice9: est9, qty9,
      });
      await opts.post(tradeNote({
        sleeve, symbol: ex.symbol, side: "sell", intent: "sell", qty: d9str(qty9),
        reason: `${ex.type} effective ${ex.effectiveDate} — exit before`,
      }));
    } else {
      remaining.push(ex); // not placed → keep it in the plan for the next pass
      await opts.post(skipNote(sleeve, ex.symbol, res.skipped ?? "REJECTED", res.detail));
    }
  }
  storeCorpPlan(db, { ...plan, exitBefore: remaining });
  return out;
}
