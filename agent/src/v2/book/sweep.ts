// Bull v2 — SGOV cash sweep (design §1). Idle SETTLED cash above a $50 float goes to SGOV (0–3mo
// T-bills) so the book isn't structurally penalized for holding dry powder; SGOV is excluded from
// all risk/exposure math and is liquidated FIRST whenever a sleeve needs cash. Sweep orders are
// owned by "book" (intent "sweep") and go through the same gateway as everything else.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, mul9, div9, min9, type D9 } from "./../decimal.js";
import { settledCash } from "./../settled-cash.js";
import { ledgerPosition } from "./../lots.js";
import { placeOrder, type PlaceResult } from "./../order-gateway.js";
import type { BrokerPort } from "./../broker.js";

export interface SweepConfig { etf: string; floatUsd: number; }

export interface SweepPlan {
  action: "buy" | "sell" | "none";
  notional9?: D9;   // buy side
  qty9?: D9;        // sell side
  reason: string;
}

/** Pure: decide the sweep given settled cash, the float, and a pending cash NEED (a sleeve about to
 *  buy). needUsd9 > settled → sell enough SGOV to cover (plus the float stays untouched);
 *  settled − need > float → sweep the excess in. */
export function decideSweep(opts: {
  settled9: D9; float9: D9; need9: D9; sgovQty9: D9; sgovPrice9: D9;
}): SweepPlan {
  const { settled9, float9, need9, sgovQty9, sgovPrice9 } = opts;
  const shortfall = need9 - settled9;
  if (shortfall > 0n) {
    if (sgovQty9 <= 0n) return { action: "none", reason: "shortfall but no SGOV to liquidate" };
    const qtyNeeded = div9(shortfall, sgovPrice9);
    const qty = min9(qtyNeeded, sgovQty9);
    return { action: "sell", qty9: qty, reason: `liquidate SGOV first: need ${d9str(shortfall)} beyond settled` };
  }
  const idle = settled9 - need9 - float9;
  if (idle > 0n) return { action: "buy", notional9: idle, reason: `sweep idle settled cash above ${d9str(float9)} float` };
  return { action: "none", reason: "no idle cash beyond float" };
}

/** Execute today's sweep. `need9` = cash a sleeve run is about to spend (0 for the idle-sweep pass).
 *  Never throws on a gate refusal — the gateway records it. */
export async function runSweep(db: DatabaseSync, broker: BrokerPort, opts: {
  cfg: SweepConfig; asOfDate: string; configVersion: string; need9?: D9; sgovPrice9: D9; washBlacklistDays: number;
}): Promise<{ plan: SweepPlan; result?: PlaceResult }> {
  const plan = decideSweep({
    settled9: settledCash(db, opts.asOfDate),
    float9: d9(String(opts.cfg.floatUsd)),
    need9: opts.need9 ?? 0n,
    sgovQty9: ledgerPosition(db, opts.cfg.etf),
    sgovPrice9: opts.sgovPrice9,
  });
  if (plan.action === "none") return { plan };
  const result = await placeOrder(db, broker, {
    owner: "book", symbol: opts.cfg.etf, intent: "sweep",
    side: plan.action, type: "market",
    ...(plan.action === "buy" ? { notional9: plan.notional9! } : { qty9: plan.qty9!, estPrice9: opts.sgovPrice9 }),
    asOfDate: opts.asOfDate, configVersion: opts.configVersion,
    blacklistExempt: true, // SGOV parking is cash management, not a position re-entry
  }, { washBlacklistDays: opts.washBlacklistDays });
  return { plan, result };
}

/** SGOV market value (excluded from risk math, included in book equity). */
export function sgovValue9(db: DatabaseSync, etf: string, price9: D9): D9 {
  return mul9(ledgerPosition(db, etf), price9);
}
