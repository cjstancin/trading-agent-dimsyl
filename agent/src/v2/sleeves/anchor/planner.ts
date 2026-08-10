// Bull v2 — Anchor: rebuild planner + executor. Pure diff of (target weights × sleeve equity)
// against the anchor sleeve's ledger positions, then orders through the SHARED gateway only —
// placeOrder runs the halt/$1-floor/blacklist/settled-cash stack; nothing here re-implements a gate.
//
// Trade discipline (design):
//   · manager-follow: a held symbol with NO target (name left every manager's top-5) → full exit;
//   · a position inside the 20%-RELATIVE drift band is left alone (|current − target| / target ≤
//     band) — the sleeve is a low-churn clone, ~10–15 orders/quarter steady-state;
//   · SELLS first, then buys (paper T+1 means today's sale proceeds aren't spendable today — the
//     settled-cash gate will size buys against what's actually settled, and a refused buy simply
//     re-fires at the next rebuild; correctness over eagerness);
//   · no stops, no LEI dial — the sleeve deliberately buys fear (design: exits are manager-follow
//     only).
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, mul9, div9, min9, abs9, type D9 } from "../../decimal.js";
import { placeOrder, type PlaceResult } from "../../order-gateway.js";
import type { BrokerPort } from "../../broker.js";
import type { PlannedOrder } from "./types.js";

/** Anchor-sleeve ledger positions (Σ qty_remaining over lots tagged sleeve='anc'). Reads the shared
 *  lots table directly because the shared helpers aggregate across sleeves; read-only by contract. */
export function anchorPositions(db: DatabaseSync): Map<string, D9> {
  const rows = db.prepare("SELECT symbol, qty_remaining9 FROM lots WHERE sleeve='anc'").all() as
    { symbol: string; qty_remaining9: string }[];
  const out = new Map<string, D9>();
  for (const r of rows) out.set(r.symbol, (out.get(r.symbol) ?? 0n) + d9(r.qty_remaining9));
  for (const [k, v] of out) if (v === 0n) out.delete(k);
  return out;
}

export interface PlanInput {
  targets: Map<string, D9>;     // symbol → weight9 (fraction of sleeve)
  positions: Map<string, D9>;   // symbol → held qty9 (anchor sleeve)
  prices: Map<string, D9>;      // symbol → latest price9 (union of targets ∪ positions)
  sleeveEquity9: D9;            // anchor sleeve equity in d9 dollars
  driftBandRel: number;         // config anchor.driftBandRel (0.2)
  reason: string;               // "initial-build" | "q2-2026-filing" | "amendment-restated" …
}

export interface PlanResult {
  orders: PlannedOrder[];       // sells first, then buys
  problems: string[];           // unpriceable symbols etc. — surfaced, never silently skipped
}

/** Diff targets vs holdings into orders. Pure. */
export function planRebuild(input: PlanInput): PlanResult {
  const { targets, positions, prices, sleeveEquity9 } = input;
  const band9 = d9(input.driftBandRel);
  const sells: PlannedOrder[] = [];
  const buys: PlannedOrder[] = [];
  const problems: string[] = [];

  const priceOf = (sym: string): D9 | null => {
    const p = prices.get(sym);
    if (p == null || p <= 0n) { problems.push(`no price for ${sym} — line skipped this rebuild`); return null; }
    return p;
  };

  // Manager-follow exits: held but no longer targeted anywhere.
  for (const [sym, qty] of positions) {
    if (targets.has(sym)) continue;
    const px = priceOf(sym);
    if (px == null) continue;
    sells.push({ symbol: sym, side: "sell", intent: "sell", qty9: qty, estPrice9: px, reason: "manager-follow" });
  }

  // Rebalance toward targets, respecting the relative drift band.
  for (const [sym, weight9] of targets) {
    const px = priceOf(sym);
    if (px == null) continue;
    const target9 = mul9(weight9, sleeveEquity9);          // target dollars
    if (target9 <= 0n) continue;
    const held = positions.get(sym) ?? 0n;
    const current9 = mul9(held, px);                       // current dollars
    const diff9 = target9 - current9;
    if (held === 0n) {
      buys.push({ symbol: sym, side: "buy", intent: "buy", notional9: target9, estPrice9: px, reason: input.reason });
      continue;
    }
    // Relative drift: |diff| / target — trade only STRICTLY outside the band (19% holds, 21% trades).
    const rel9 = div9(abs9(diff9), target9);
    if (rel9 <= band9) continue;
    if (diff9 > 0n) {
      buys.push({ symbol: sym, side: "buy", intent: "buy", notional9: diff9, estPrice9: px, reason: `drift>band` });
    } else {
      const qty = min9(div9(abs9(diff9), px), held);       // never oversell the ledger
      if (qty > 0n) sells.push({ symbol: sym, side: "sell", intent: "sell", qty9: qty, estPrice9: px, reason: `drift>band` });
    }
  }

  return { orders: [...sells, ...buys], problems };
}

export interface ExecuteResult {
  placed: number;
  refused: { symbol: string; result: PlaceResult }[];
  results: PlaceResult[];
}

/** Execute a plan through the shared order gateway (owner 'anc', market/day). Sequential on
 *  purpose — the settled-cash gate reads open buy reservations, and parallel placement would race
 *  its own reservations. A refusal is recorded by the gateway AND returned here; nothing throws
 *  on a gate refusal (design: no order path fails quietly, none fails loudly-and-stops-the-rest). */
export async function executePlan(
  db: DatabaseSync, broker: BrokerPort, orders: PlannedOrder[],
  opts: { asOfDate: string; configVersion: string; washBlacklistDays: number },
): Promise<ExecuteResult> {
  const results: PlaceResult[] = [];
  const refused: { symbol: string; result: PlaceResult }[] = [];
  for (const o of orders) {
    const res = await placeOrder(db, broker, {
      owner: "anc",
      symbol: o.symbol,
      intent: o.intent,
      side: o.side,
      type: "market",
      tif: "day",
      ...(o.qty9 != null ? { qty9: o.qty9 } : {}),
      ...(o.notional9 != null ? { notional9: o.notional9 } : {}),
      estPrice9: o.estPrice9,
      asOfDate: opts.asOfDate,
      configVersion: opts.configVersion,
    }, { washBlacklistDays: opts.washBlacklistDays });
    results.push(res);
    if (!res.placed) refused.push({ symbol: o.symbol, result: res });
  }
  return { placed: results.filter((r) => r.placed).length, refused, results };
}

/** Upsert anchor rows in the shared position_meta table (sleeve-owned rows by contract): target
 *  weight + which managers contribute, so the dashboard can render "why do we hold this". */
export function writePositionMeta(db: DatabaseSync, targets: Map<string, D9>, slotsBySymbol: Map<string, string[]>): void {
  const stmt = db.prepare(
    `INSERT INTO position_meta(sleeve, symbol, meta, updated_ts) VALUES('anc',?,?,?)
     ON CONFLICT(sleeve, symbol) DO UPDATE SET meta=excluded.meta, updated_ts=excluded.updated_ts`,
  );
  const now = new Date().toISOString();
  for (const [sym, w] of targets) {
    stmt.run(sym, JSON.stringify({ targetWeight: d9str(w), managers: slotsBySymbol.get(sym) ?? [] }), now);
  }
}
