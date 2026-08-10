// Bull v2 — momentum honesty ledger (design §2). Alpaca paper fills are frictionless fantasy: no
// spread, no impact, no fees. The honesty ledger books what those trades WOULD have cost — 5 bps of
// notional per side (synthetic slippage) + $0.01 per sell (regulatory-ish fee) — keyed to the REAL
// order intent (client_order_id), so the sleeve's evaluated performance is net of realistic drag.
//
// ANALYTICS ONLY, by hard rule: these rows never touch fills/lots/disposals/cash_events. The tax
// ledger records actual paper fills; the honesty ledger is the skeptical overlay the shadow-book
// comparison reads. Idempotent by coid (INSERT OR REPLACE — a re-run re-prices, never double-books).
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, mul9, div9, type D9 } from "../../decimal.js";
import type { MomentumConfig } from "./ports.js";

export interface HonestyEntry {
  clientOrderId: string;
  ts: string;                // ISO
  symbol: string;
  side: "buy" | "sell";
  notional9: D9;             // estimated notional the costs are computed from
}

/** Book one order's synthetic costs. slippage = notional × bps/10000 (d9 math, half-up); the sell
 *  fee comes straight from config. Returns the recorded row values for the caller's summary. */
export function recordHonesty(db: DatabaseSync, e: HonestyEntry, cfg: MomentumConfig): { slippage9: D9; fee9: D9 } {
  // bps → fraction in d9 space: (notional × bps) / 10000 — avoids float on the money path.
  const slippage9 = div9(mul9(e.notional9, d9(String(cfg.slippageBpsPerSide))), d9("10000"));
  const fee9 = e.side === "sell" ? d9(String(cfg.sellFeeUsd)) : 0n;
  db.prepare(
    `INSERT OR REPLACE INTO mom_honesty(client_order_id, ts, symbol, side, notional9, slippage9, fee9)
     VALUES(?,?,?,?,?,?,?)`,
  ).run(e.clientOrderId, e.ts, e.symbol, e.side, d9str(e.notional9), d9str(slippage9), d9str(fee9));
  return { slippage9, fee9 };
}

/** Total synthetic drag for a month ("YYYY-MM" prefix on ts) — the shadow-book compare pulls this
 *  to show sleeve-net vs shadow vs cost-free on the same footing. */
export function honestyTotals(db: DatabaseSync, month: string): { slippage9: D9; fees9: D9; orders: number } {
  const rows = db
    .prepare("SELECT slippage9, fee9 FROM mom_honesty WHERE substr(ts, 1, 7) = ?")
    .all(month) as { slippage9: string; fee9: string }[];
  let slippage9 = 0n;
  let fees9 = 0n;
  for (const r of rows) { slippage9 += d9(r.slippage9); fees9 += d9(r.fee9); }
  return { slippage9, fees9, orders: rows.length };
}
