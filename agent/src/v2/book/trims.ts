// Bull v2 — dial trims (design §2). When the LEI dial DOWNGRADES, the dialed sleeves (Momentum +
// Wildcard) don't just size new buys smaller — existing exposure above the new target is trimmed
// through the normal exit paths. Trims are proportional across the sleeve's positions (largest
// first for rounding), respect the $25 min-order dust threshold, and go through the gateway as
// intent "trim" (market sells; sells need no cash gate).
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, mul9, div9, min9, allocate9, type D9 } from "./../decimal.js";
import { placeOrder, type PlaceResult } from "./../order-gateway.js";
import type { BrokerPort } from "./../broker.js";
import type { Sleeve } from "./../types.js";

export interface TrimOrder { symbol: string; qty9: D9; estPrice9: D9; }

/** Pure: proportional trim plan for one sleeve. target9 = sleeveBudget × dialScalar; band keeps a
 *  ±rel% dead zone so a 1% overshoot never churns. minOrder9 drops dust legs. */
export function planDialTrims(opts: {
  positions: { symbol: string; qty9: D9; price9: D9 }[];
  target9: D9;
  bandRel: number;      // e.g. 0.1 → trim only when value > target × 1.1
  minOrder9: D9;        // $25
}): TrimOrder[] {
  const { positions, target9, bandRel, minOrder9 } = opts;
  const values = positions.map((p) => mul9(p.qty9, p.price9));
  const total = values.reduce((a, b) => a + b, 0n);
  const band = mul9(target9, d9(String(1 + bandRel)));
  if (total <= band) return [];
  const excess = total - target9;
  // Allocate the excess across positions proportionally to value (exact), then convert to qty.
  const parts = allocate9(excess, values);
  const out: TrimOrder[] = [];
  for (let i = 0; i < positions.length; i++) {
    if (parts[i] < minOrder9) continue; // dust — leave it; the band already tolerates slack
    const p = positions[i];
    const qty = min9(div9(parts[i], p.price9), p.qty9);
    if (qty <= 0n) continue;
    out.push({ symbol: p.symbol, qty9: qty, estPrice9: p.price9 });
  }
  return out;
}

/** Execute a trim plan through the gateway (sells; blacklist-exempt by nature — they ARE exits). */
export async function executeTrims(db: DatabaseSync, broker: BrokerPort, sleeve: Sleeve, plan: TrimOrder[], opts: {
  asOfDate: string; configVersion: string; washBlacklistDays: number;
}): Promise<PlaceResult[]> {
  const results: PlaceResult[] = [];
  for (const t of plan) {
    results.push(await placeOrder(db, broker, {
      owner: sleeve, symbol: t.symbol, intent: "trim", side: "sell", type: "market",
      qty9: t.qty9, estPrice9: t.estPrice9,
      asOfDate: opts.asOfDate, configVersion: opts.configVersion,
    }, { washBlacklistDays: opts.washBlacklistDays }));
  }
  return results;
}

/** Sleeve market value from its lots (risk view — excludes SGOV by construction since SGOV lots are
 *  owned by "book"). */
export function sleeveValue9(db: DatabaseSync, sleeve: Sleeve, prices: Map<string, D9>): { value9: D9; positions: { symbol: string; qty9: D9; price9: D9 }[] } {
  const rows = db
    .prepare("SELECT symbol, qty_remaining9 FROM lots WHERE sleeve=? AND CAST(qty_remaining9 AS TEXT) != '0'")
    .all(sleeve) as { symbol: string; qty_remaining9: string }[];
  const bySymbol = new Map<string, D9>();
  for (const r of rows) bySymbol.set(r.symbol, (bySymbol.get(r.symbol) ?? 0n) + d9(r.qty_remaining9));
  const positions: { symbol: string; qty9: D9; price9: D9 }[] = [];
  let value = 0n;
  for (const [symbol, qty] of [...bySymbol.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (qty <= 0n) continue;
    const price = prices.get(symbol);
    if (price == null) continue; // no price → skip from trim math (never trim blind)
    positions.push({ symbol, qty9: qty, price9: price });
    value += mul9(qty, price);
  }
  return { value9: value, positions };
}
